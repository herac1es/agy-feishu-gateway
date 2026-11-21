import type { AcpToolEvent } from '../acp/client.js';
import {
  formatFeishuError,
  type FeishuCotEvent,
  type FeishuGatewayClient,
  type FeishuMessageCotHandle,
  type FeishuSendTarget,
} from './client.js';

export const COT_MAX_EVENTS_PER_WRITE = 50;
export const COT_MAX_EVENT_CONTENT_CHARS = 1000;
export const COT_MAX_REASONING_CHUNK_CHARS = 600;
export const COT_MAX_TOOL_ARGS_CHARS = 500;
export const COT_MAX_TOOL_RESULT_CHARS = 600;

const TOOL_KIND_ICONS: Record<string, string> = {
  read: 'read',
  edit: 'write',
  delete: 'write',
  move: 'write',
  search: 'search',
  fetch: 'search',
  execute: 'bash',
};

let lastEventTimestamp = 0;

function nextEventTimestamp(): string {
  lastEventTimestamp = Math.max(Date.now(), lastEventTimestamp + 1);
  return String(lastEventTimestamp);
}

function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function splitChars(text: string, maxChars: number): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

export function encodeBoundedCotContent(payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload);
  if (raw.length <= COT_MAX_EVENT_CONTENT_CHARS) {
    return raw;
  }

  // Shrink string delta/message or nested tool code content until serialized JSON fits safely.
  if (typeof payload.delta === 'string') {
    const copy: Record<string, unknown> = { ...payload, truncated: true };
    let val = payload.delta;
    while (val.length > 0 && JSON.stringify({ ...copy, delta: val }).length > COT_MAX_EVENT_CONTENT_CHARS) {
      val = val.slice(0, Math.max(0, Math.floor(val.length * 0.7) - 32));
    }
    return JSON.stringify({ ...copy, delta: val });
  }

  if (typeof payload.message === 'string') {
    const copy: Record<string, unknown> = { ...payload, truncated: true };
    let val = payload.message;
    while (val.length > 0 && JSON.stringify({ ...copy, message: val }).length > COT_MAX_EVENT_CONTENT_CHARS) {
      val = val.slice(0, Math.max(0, Math.floor(val.length * 0.7) - 32));
    }
    return JSON.stringify({ ...copy, message: val });
  }

  if (
    payload.content &&
    typeof payload.content === 'object' &&
    typeof (payload.content as { code?: unknown }).code === 'string'
  ) {
    const inner = payload.content as Record<string, unknown> & { code: string };
    let code = inner.code;
    while (
      code.length > 0 &&
      JSON.stringify({ ...payload, content: { ...inner, code } }).length > COT_MAX_EVENT_CONTENT_CHARS
    ) {
      code = code.slice(0, Math.max(0, Math.floor(code.length * 0.7) - 32));
    }
    return JSON.stringify({
      ...payload,
      content: { ...inner, code: code ? `${code}…` : '…' },
    });
  }

  return JSON.stringify({ truncated: true });
}

function makeCotEvent(eventType: string, payload: Record<string, unknown>): FeishuCotEvent {
  return {
    event_type: eventType,
    content: encodeBoundedCotContent(payload),
    timestamp: nextEventTimestamp(),
  };
}

export function resolveCotToolIcon(event: Pick<AcpToolEvent, 'kind' | 'name' | 'label'>): string {
  const kind = event.kind?.toLowerCase();
  if (kind && TOOL_KIND_ICONS[kind]) {
    return TOOL_KIND_ICONS[kind];
  }
  const text = `${event.name ?? ''} ${event.label ?? ''}`.toLowerCase();
  if (/read|view|list|get|cat/.test(text)) return 'read';
  if (/edit|write|create|patch|update|delete|remove|move/.test(text)) return 'write';
  if (/search|grep|glob|find|web|fetch|http/.test(text)) return 'search';
  if (/shell|bash|command|exec|terminal|run_command/.test(text)) return 'bash';
  return 'default';
}

export interface FeishuNativeCotSessionOptions {
  runId: string;
  flushIntervalMs?: number;
  hidden?: boolean;
  onError?: (err: unknown) => void;
}

/**
 * Manages one native Feishu `im/v1/message_cot` lifecycle for an agent turn.
 * Any write/complete error after creation is strictly contained so it never blocks final replies.
 */
export class FeishuNativeCotSession {
  private readonly flushIntervalMs: number;
  private readonly runId: string;
  private readonly hidden: boolean;
  private readonly onError?: (err: unknown) => void;

  private handle: FeishuMessageCotHandle | null = null;
  private broken = false;
  private finished = false;
  private chain: Promise<void> = Promise.resolve();
  private pendingEvents: FeishuCotEvent[] = [];

  private reasoningOpen = false;
  private reasoningSeq = 0;
  private currentReasoningId = '';
  private bufferedThought = '';
  private flushTimer: NodeJS.Timeout | null = null;

  private readonly startedToolIds = new Set<string>();
  private readonly finishedToolIds = new Set<string>();

  constructor(
    private readonly feishu: Pick<
      FeishuGatewayClient,
      'createMessageCot' | 'writeMessageCotEvents' | 'completeMessageCot'
    >,
    private readonly target: FeishuSendTarget,
    options: FeishuNativeCotSessionOptions,
  ) {
    this.runId = options.runId;
    this.flushIntervalMs = Math.max(50, options.flushIntervalMs ?? 200);
    this.hidden = options.hidden === true;
    this.onError = options.onError;
  }

  getHandle(): FeishuMessageCotHandle | null {
    return this.handle;
  }

  isActive(): boolean {
    return Boolean(this.handle) && !this.broken;
  }

  async start(): Promise<boolean> {
    if (this.handle) {
      return true;
    }
    if (this.broken || this.finished) {
      return false;
    }
    try {
      this.handle = await this.feishu.createMessageCot(this.target, {
        hidden: this.hidden,
      });
    } catch (err) {
      this.broken = true;
      this.onError?.(err);
      return false;
    }

    this.enqueue([
      makeCotEvent('RUN_STARTED', {
        threadId: this.target.chatId,
        runId: this.runId,
      }),
    ]);
    return true;
  }

  pushThoughtDelta(delta: string): void {
    if (!this.handle || this.broken || this.finished || !delta) {
      return;
    }
    this.bufferedThought += delta;
    if (this.bufferedThought.length >= COT_MAX_REASONING_CHUNK_CHARS) {
      this.flushBufferedThought();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushBufferedThought();
      }, this.flushIntervalMs);
    }
  }

  notifyReplyStarted(): void {
    if (!this.handle || this.broken || this.finished) {
      return;
    }
    this.flushBufferedThought();
    this.closeReasoning();
  }

  pushToolEvent(event: AcpToolEvent): void {
    if (!this.handle || this.broken || this.finished) {
      return;
    }
    this.flushBufferedThought();
    this.closeReasoning();

    const events: FeishuCotEvent[] = [];
    if (!this.startedToolIds.has(event.toolCallId)) {
      this.startedToolIds.add(event.toolCallId);
      const title = truncateChars(event.label || event.name || 'Tool', 120);
      const toolCallName = truncateChars(event.name || event.label || 'tool', 80);
      events.push(
        makeCotEvent('TOOL_CALL_START', {
          toolCallId: event.toolCallId,
          icon: resolveCotToolIcon(event),
          title,
          toolCallName,
        }),
      );
      if (event.argsText) {
        events.push(
          makeCotEvent('TOOL_CALL_ARGS', {
            toolCallId: event.toolCallId,
            delta: truncateChars(event.argsText, COT_MAX_TOOL_ARGS_CHARS),
          }),
        );
      }
      events.push(
        makeCotEvent('TOOL_CALL_END', {
          toolCallId: event.toolCallId,
        }),
      );
    }

    if (
      (event.status === 'completed' || event.status === 'failed') &&
      !this.finishedToolIds.has(event.toolCallId)
    ) {
      this.finishedToolIds.add(event.toolCallId);
      const failed = event.status === 'failed';
      const fallbackResult = failed ? 'Tool execution failed' : 'OK';
      events.push(
        makeCotEvent('TOOL_CALL_RESULT', {
          messageId: `result-${event.toolCallId}`,
          toolCallId: event.toolCallId,
          role: 'tool',
          content: {
            type: 'code',
            code: truncateChars(event.resultText || fallbackResult, COT_MAX_TOOL_RESULT_CHARS),
          },
          ...(failed ? { error: 'TOOL_FAILED' } : {}),
        }),
      );
    }

    if (events.length > 0) {
      this.enqueue(events);
    }
  }

  async finish(outcome: {
    status: 'completed' | 'cancelled' | 'error';
    errorMessage?: string;
  }): Promise<void> {
    if (this.finished) {
      await this.chain;
      return;
    }
    this.finished = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.handle || this.broken) {
      await this.chain;
      return;
    }

    this.flushBufferedThought();
    this.closeReasoning();

    if (outcome.status === 'completed') {
      this.enqueue([
        makeCotEvent('RUN_FINISHED', {
          threadId: this.target.chatId,
          runId: this.runId,
          status: 'done',
        }),
      ]);
    } else {
      const defaultMsg = outcome.status === 'cancelled' ? '已中止当前回合' : '执行失败';
      this.enqueue([
        makeCotEvent('RUN_ERROR', {
          message: truncateChars(outcome.errorMessage || defaultMsg, 400),
          code: outcome.status === 'cancelled' ? 'TURN_CANCELLED' : 'TURN_FAILED',
        }),
      ]);
    }

    await this.chain;
    if (this.broken || !this.handle) {
      return;
    }

    try {
      await this.feishu.completeMessageCot(this.handle);
    } catch (err) {
      this.broken = true;
      this.onError?.(err);
    }
  }

  private flushBufferedThought(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const text = this.bufferedThought;
    this.bufferedThought = '';
    if (!text || !this.handle || this.broken) {
      return;
    }

    const events: FeishuCotEvent[] = [];
    if (!this.reasoningOpen) {
      this.reasoningSeq += 1;
      this.currentReasoningId = `reasoning-${this.runId}-${this.reasoningSeq}`;
      this.reasoningOpen = true;
      events.push(
        makeCotEvent('REASONING_MESSAGE_START', {
          messageId: this.currentReasoningId,
          role: 'reasoning',
        }),
      );
    }

    for (const chunk of splitChars(text, COT_MAX_REASONING_CHUNK_CHARS)) {
      events.push(
        makeCotEvent('REASONING_MESSAGE_CONTENT', {
          messageId: this.currentReasoningId,
          delta: chunk,
        }),
      );
    }

    this.enqueue(events);
  }

  private closeReasoning(): void {
    if (!this.reasoningOpen || !this.currentReasoningId) {
      return;
    }
    this.reasoningOpen = false;
    const messageId = this.currentReasoningId;
    this.currentReasoningId = '';
    this.enqueue([
      makeCotEvent('REASONING_MESSAGE_END', {
        messageId,
      }),
    ]);
  }

  private enqueue(events: FeishuCotEvent[]): void {
    if (this.broken || !this.handle || events.length === 0) {
      return;
    }
    this.pendingEvents.push(...events);
    const activeHandle = this.handle;

    this.chain = this.chain
      .then(async () => {
        if (this.broken) {
          this.pendingEvents.length = 0;
          return;
        }
        while (this.pendingEvents.length > 0) {
          const batch = this.pendingEvents.splice(0, COT_MAX_EVENTS_PER_WRITE);
          await this.feishu.writeMessageCotEvents(activeHandle, batch);
        }
      })
      .catch((err) => {
        this.broken = true;
        this.pendingEvents.length = 0;
        this.onError?.(err);
        console.warn(`[gateway] 飞书原生 COT 事件写入失败（已忽略，不影响最终回复）: ${formatFeishuError(err)}`);
      });
  }
}
