import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { FEISHU_SYSTEM_PROMPT_APPEND } from '../directives.js';

export interface AcpSelectOption {
  id: string;
  name: string;
  description?: string | null;
}

export type AcpModelOption = AcpSelectOption;
export type AcpThoughtLevelOption = AcpSelectOption;

export interface AcpSessionConfigState {
  currentModelId?: string;
  availableModels: AcpModelOption[];
  currentThoughtLevel?: string;
  availableThoughtLevels: AcpThoughtLevelOption[];
}

export interface AcpToolEvent {
  toolCallId: string;
  label: string;
  status: string;
  kind?: string;
  name?: string;
  argsText?: string;
  resultText?: string;
}

export interface AcpUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  contextUsed?: number;
  contextSize?: number;
}

export interface AcpPromptHandlers {
  onTextChunk?: (accumulatedText: string, delta: string) => void;
  onThoughtChunk?: (accumulatedThought: string, delta: string) => void;
  onToolEvent?: (event: AcpToolEvent, allEvents: AcpToolEvent[]) => void;
  onUsage?: (usage: AcpUsageSummary) => void;
}

export interface AcpPromptResult {
  stopReason: acp.StopReason;
  text: string;
  thoughtText: string;
  toolEvents: AcpToolEvent[];
  usage: AcpUsageSummary;
}

export interface AcpAsyncTurnResult {
  sessionId: string;
  text: string;
  thoughtText: string;
  toolEvents: AcpToolEvent[];
  usage: AcpUsageSummary;
  elapsedMs: number;
}

export interface EnsureSessionParams {
  cwd: string;
  sessionId?: string;
  modelId?: string;
  thoughtLevel?: string;
}

export interface EnsureSessionResult extends AcpSessionConfigState {
  sessionId: string;
  loaded: boolean;
  currentModeId?: string;
}

interface ActiveSessionState extends AcpSessionConfigState {
  sessionId: string;
  cwd: string;
  currentModeId?: string;
}

interface ActiveTurnCollector {
  text: string;
  thoughtText: string;
  lastEventWasThought: boolean;
  lastEventWasTool: boolean;
  toolEventsMap: Map<string, AcpToolEvent>;
  usage: AcpUsageSummary;
  handlers: AcpPromptHandlers;
  currentPromptPromise?: Promise<acp.PromptResponse>;
  steerSeq: number;
}

interface AsyncTurnBuffer {
  startedAt: number;
  text: string;
  thoughtText: string;
  lastEventWasThought: boolean;
  lastEventWasTool: boolean;
  toolEventsMap: Map<string, AcpToolEvent>;
  usage: AcpUsageSummary;
  settleTimer: NodeJS.Timeout | null;
}

function summarizeRawInput(rawInput: unknown): string {
  if (!rawInput || typeof rawInput !== 'object') {
    return '';
  }
  const obj = rawInput as Record<string, unknown>;
  for (const key of ['toolSummary', 'CommandLine', 'command', 'Path', 'path', 'TargetFile', 'query']) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim().slice(0, 60);
    }
  }
  return '';
}

function serializeBoundedValue(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  let text: string;
  if (typeof value === 'string') {
    text = value.trim();
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (!text) {
    return undefined;
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function extractToolResultText(
  update: { rawOutput?: unknown; content?: Array<acp.ToolCallContent> | null },
  maxChars = 1000,
): string | undefined {
  const fromRaw = serializeBoundedValue(update.rawOutput, maxChars);
  if (fromRaw) {
    return fromRaw;
  }
  if (!Array.isArray(update.content) || update.content.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of update.content) {
    if (item && typeof item === 'object' && 'type' in item) {
      if (item.type === 'content' && 'content' in item && item.content?.type === 'text' && item.content.text) {
        parts.push(item.content.text);
      } else if (item.type === 'diff' && 'path' in item) {
        parts.push(`diff: ${String(item.path)}`);
      }
    }
  }
  const joined = parts.join('\n').trim();
  if (!joined) {
    return undefined;
  }
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - 1)}…`;
}

function formatToolLabel(
  update: {
    title?: string | null;
    name?: string | null;
    rawInput?: unknown;
    kind?: acp.ToolKind | null;
  },
  existing?: AcpToolEvent,
): string {
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  const name = typeof update.name === 'string' ? update.name.trim() : '';
  const argHint = summarizeRawInput(update.rawInput);

  if (title && title !== name) {
    return title;
  }
  if (name && argHint) {
    return `${name}: ${argHint}`;
  }
  if (title) {
    return title;
  }
  if (name) {
    return name;
  }
  if (existing?.label) {
    return existing.label;
  }
  return update.kind ? `${update.kind}` : 'tool';
}

function flattenSelectOptions(
  opt: Extract<acp.SessionConfigOption, { type: 'select' }>,
): AcpSelectOption[] {
  const items: AcpSelectOption[] = [];
  for (const entry of opt.options) {
    if ('options' in entry && Array.isArray(entry.options)) {
      for (const sub of entry.options) {
        items.push({ id: sub.value, name: sub.name, description: sub.description });
      }
    } else if ('value' in entry) {
      items.push({ id: entry.value, name: entry.name, description: entry.description });
    }
  }
  return items;
}

interface ExtractedSessionConfig extends AcpSessionConfigState {
  hasConfigOptions: boolean;
}

function extractConfigFromSessionResponse(resp: unknown): ExtractedSessionConfig {
  if (!resp || typeof resp !== 'object') {
    return { availableModels: [], availableThoughtLevels: [], hasConfigOptions: false };
  }
  const obj = resp as Record<string, unknown>;
  let availableModels: AcpModelOption[] = [];
  let currentModelId: string | undefined;
  let availableThoughtLevels: AcpThoughtLevelOption[] = [];
  let currentThoughtLevel: string | undefined;
  const hasConfigOptions = Array.isArray(obj.configOptions);

  if (hasConfigOptions) {
    for (const opt of obj.configOptions as acp.SessionConfigOption[]) {
      if (opt.type !== 'select') continue;
      if (opt.id === 'model' || opt.category === 'model') {
        currentModelId = opt.currentValue;
        availableModels = flattenSelectOptions(opt);
      } else if (opt.id === 'thought_level' || opt.category === 'thought_level') {
        currentThoughtLevel = opt.currentValue;
        availableThoughtLevels = flattenSelectOptions(opt);
      }
    }
  }

  // Fallback for agents exposing legacy `models.availableModels`
  if (availableModels.length === 0 && obj.models && typeof obj.models === 'object') {
    const legacy = obj.models as {
      currentModelId?: unknown;
      availableModels?: Array<{ modelId?: unknown; name?: unknown }>;
    };
    if (typeof legacy.currentModelId === 'string') {
      currentModelId = legacy.currentModelId;
    }
    if (Array.isArray(legacy.availableModels)) {
      for (const item of legacy.availableModels) {
        if (typeof item.modelId === 'string') {
          availableModels.push({
            id: item.modelId,
            name: typeof item.name === 'string' ? item.name : item.modelId,
          });
        }
      }
    }
  }

  return {
    currentModelId,
    availableModels,
    currentThoughtLevel,
    availableThoughtLevels,
    hasConfigOptions,
  };
}

export class AgyAcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientConnection | null = null;
  private initPromise: Promise<acp.InitializeResponse> | null = null;
  private agentInfo: acp.Implementation | null = null;
  private cachedModels: AcpModelOption[] = [];
  private cachedThoughtLevels: AcpThoughtLevelOption[] = [];
  private loadedSessions = new Map<string, ActiveSessionState>();
  private replayingSessions = new Set<string>();
  private activeCollectors = new Map<string, ActiveTurnCollector>();
  private asyncBuffers = new Map<string, AsyncTurnBuffer>();
  private asyncTurnHandler: ((result: AcpAsyncTurnResult) => void | Promise<void>) | null = null;
  private readonly asyncSettleAfterUsageMs: number;
  private readonly asyncSettleFallbackMs: number;
  private shuttingDown = false;

  constructor(
    private readonly options: {
      agyBin: string;
      defaultCwd: string;
      systemPromptAppend?: string;
      logger?: (msg: string) => void;
      onAsyncTurn?: (result: AcpAsyncTurnResult) => void | Promise<void>;
      asyncSettleAfterUsageMs?: number;
      asyncSettleFallbackMs?: number;
    },
  ) {
    this.asyncTurnHandler = options.onAsyncTurn ?? null;
    this.asyncSettleAfterUsageMs = Math.max(20, options.asyncSettleAfterUsageMs ?? 1500);
    this.asyncSettleFallbackMs = Math.max(
      this.asyncSettleAfterUsageMs,
      options.asyncSettleFallbackMs ?? 4500,
    );
  }

  setAsyncTurnHandler(
    handler: ((result: AcpAsyncTurnResult) => void | Promise<void>) | null,
  ): void {
    this.asyncTurnHandler = handler;
  }

  takePendingAsyncTurn(sessionId: string): AcpAsyncTurnResult | null {
    const buffer = this.asyncBuffers.get(sessionId);
    if (!buffer) {
      return null;
    }
    this.clearAsyncBuffer(sessionId, buffer);
    if (!buffer.text.trim()) {
      return null;
    }
    return this.buildAsyncTurnResult(sessionId, buffer);
  }

  private clearAsyncBuffer(sessionId: string, buffer?: AsyncTurnBuffer): void {
    const target = buffer ?? this.asyncBuffers.get(sessionId);
    if (!target) {
      return;
    }
    if (target.settleTimer) {
      clearTimeout(target.settleTimer);
      target.settleTimer = null;
    }
    if (this.asyncBuffers.get(sessionId) === target) {
      this.asyncBuffers.delete(sessionId);
    }
  }

  private buildAsyncTurnResult(sessionId: string, buffer: AsyncTurnBuffer): AcpAsyncTurnResult {
    return {
      sessionId,
      text: buffer.text.trim(),
      thoughtText: buffer.thoughtText.trim(),
      toolEvents: Array.from(buffer.toolEventsMap.values()),
      usage: { ...buffer.usage },
      elapsedMs: Math.max(1, Date.now() - buffer.startedAt),
    };
  }

  private scheduleAsyncSettle(sessionId: string, buffer: AsyncTurnBuffer, delayMs: number): void {
    if (buffer.settleTimer) {
      clearTimeout(buffer.settleTimer);
    }
    buffer.settleTimer = setTimeout(() => {
      buffer.settleTimer = null;
      if (this.asyncBuffers.get(sessionId) !== buffer) {
        return;
      }
      this.asyncBuffers.delete(sessionId);
      if (!buffer.text.trim()) {
        return;
      }
      const result = this.buildAsyncTurnResult(sessionId, buffer);
      if (this.asyncTurnHandler) {
        void Promise.resolve(this.asyncTurnHandler(result)).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`[agy acp] 异步回合回调异常 (${sessionId}): ${msg}`);
        });
      }
    }, delayMs);
    buffer.settleTimer.unref?.();
  }

  private log(msg: string): void {
    this.options.logger?.(msg);
  }

  private clearProcessState(): void {
    this.connection = null;
    this.child = null;
    this.initPromise = null;
    this.loadedSessions.clear();
    this.replayingSessions.clear();
    for (const [sessionId, buffer] of this.asyncBuffers.entries()) {
      this.clearAsyncBuffer(sessionId, buffer);
    }
    this.asyncBuffers.clear();
  }

  private async ensureConnected(): Promise<{
    connection: acp.ClientConnection;
    init: acp.InitializeResponse;
  }> {
    if (this.connection && this.initPromise) {
      const init = await this.initPromise;
      return { connection: this.connection, init };
    }

    const args = [
      'acp',
      '--stdio',
      '--dangerously-skip-permissions',
      '--include-default-customizations',
    ];
    const child = spawn(this.options.agyBin, args, {
      cwd: this.options.defaultCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          this.log(`[agy stderr] ${trimmed}`);
        }
      }
    });

    child.once('exit', (code, signal) => {
      if (!this.shuttingDown) {
        this.log(`[agy acp] 进程意外退出 (code=${code}, signal=${signal})，下次请求将自动重连`);
      }
      const conn = this.connection;
      this.clearProcessState();
      if (conn) {
        conn.close(new Error(`agy acp exited (code=${code}, signal=${signal})`));
      }
    });

    child.once('error', (err) => {
      this.log(`[agy acp] 子进程错误: ${err.message}`);
      const conn = this.connection;
      this.clearProcessState();
      if (conn) {
        conn.close(err);
      }
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const app = acp
      .client({ name: 'agy-feishu-gateway' })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        // Execution privileges maxed out per user preference: pick allow_always > allow_once > first option.
        const selected =
          params.options.find((opt) => opt.kind === 'allow_always') ??
          params.options.find((opt) => opt.kind === 'allow_once') ??
          params.options[0];
        if (!selected) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return {
          outcome: {
            outcome: 'selected',
            optionId: selected.optionId,
          },
        };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        this.handleSessionUpdate(params);
      });

    const connection = app.connect(stream);
    this.connection = connection;

    void connection.closed.then(() => {
      if (this.connection === connection) {
        this.clearProcessState();
      }
    });

    this.initPromise = connection.agent
      .request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: 'agy-feishu-gateway',
          version: '0.1.0',
        },
      })
      .then((res) => {
        this.agentInfo = res.agentInfo ?? null;
        return res;
      })
      .catch((err) => {
        if (this.connection === connection) {
          this.clearProcessState();
        }
        connection.close(err);
        throw err;
      });

    const init = await this.initPromise;
    return { connection, init };
  }

  private handleSessionUpdate(notification: acp.SessionNotification): void {
    const { sessionId, update } = notification;
    if (this.replayingSessions.has(sessionId)) {
      return;
    }

    if (update.sessionUpdate === 'config_option_update') {
      const existingSession = this.loadedSessions.get(sessionId);
      if (existingSession) {
        const merged = this.mergeCachedConfig(extractConfigFromSessionResponse(update));
        this.loadedSessions.set(sessionId, {
          ...existingSession,
          ...merged,
        });
      }
      return;
    }

    const collector = this.activeCollectors.get(sessionId);
    if (!collector) {
      if (this.loadedSessions.has(sessionId)) {
        this.handleUnsolicitedSessionUpdate(sessionId, update);
      }
      return;
    }

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type === 'text' && update.content.text) {
          const needsBreak =
            collector.lastEventWasTool &&
            collector.text.length > 0 &&
            !collector.text.endsWith('\n') &&
            !update.content.text.startsWith('\n');
          const piece = needsBreak ? `\n\n${update.content.text}` : update.content.text;
          collector.lastEventWasThought = false;
          collector.lastEventWasTool = false;
          collector.text += piece;
          collector.handlers.onTextChunk?.(collector.text, piece);
        }
        break;
      }
      case 'agent_thought_chunk': {
        if (update.content.type === 'text' && update.content.text) {
          const needsBreak =
            !collector.lastEventWasThought &&
            collector.thoughtText.length > 0 &&
            !collector.thoughtText.endsWith('\n');
          const piece = needsBreak ? `\n\n${update.content.text}` : update.content.text;
          collector.lastEventWasThought = true;
          collector.lastEventWasTool = false;
          collector.thoughtText += piece;
          collector.handlers.onThoughtChunk?.(collector.thoughtText, piece);
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        collector.lastEventWasThought = false;
        collector.lastEventWasTool = true;
        const existing = collector.toolEventsMap.get(update.toolCallId);
        const name =
          typeof update.name === 'string' && update.name.trim()
            ? update.name.trim()
            : existing?.name;
        const argsText = serializeBoundedValue(update.rawInput, 800) ?? existing?.argsText;
        const resultText = extractToolResultText(update, 1000) ?? existing?.resultText;
        const event: AcpToolEvent = {
          toolCallId: update.toolCallId,
          label: formatToolLabel(update, existing),
          status: update.status ?? existing?.status ?? 'in_progress',
          kind: update.kind ?? existing?.kind,
          name,
          argsText,
          resultText,
        };
        collector.toolEventsMap.set(update.toolCallId, event);
        collector.handlers.onToolEvent?.(event, Array.from(collector.toolEventsMap.values()));
        break;
      }
      case 'usage_update': {
        collector.usage.contextUsed = update.used;
        collector.usage.contextSize = update.size;
        collector.handlers.onUsage?.({ ...collector.usage });
        break;
      }
      default:
        break;
    }
  }

  private getOrCreateAsyncBuffer(sessionId: string): AsyncTurnBuffer {
    let buffer = this.asyncBuffers.get(sessionId);
    if (!buffer) {
      buffer = {
        startedAt: Date.now(),
        text: '',
        thoughtText: '',
        lastEventWasThought: false,
        lastEventWasTool: false,
        toolEventsMap: new Map(),
        usage: {},
        settleTimer: null,
      };
      this.asyncBuffers.set(sessionId, buffer);
    }
    return buffer;
  }

  private handleUnsolicitedSessionUpdate(
    sessionId: string,
    update: acp.SessionNotification['update'],
  ): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type === 'text' && update.content.text) {
          const buffer = this.getOrCreateAsyncBuffer(sessionId);
          const needsBreak =
            buffer.lastEventWasTool &&
            buffer.text.length > 0 &&
            !buffer.text.endsWith('\n') &&
            !update.content.text.startsWith('\n');
          const piece = needsBreak ? `\n\n${update.content.text}` : update.content.text;
          buffer.lastEventWasThought = false;
          buffer.lastEventWasTool = false;
          buffer.text += piece;
          this.scheduleAsyncSettle(sessionId, buffer, this.asyncSettleFallbackMs);
        }
        break;
      }
      case 'agent_thought_chunk': {
        if (update.content.type === 'text' && update.content.text) {
          const buffer = this.getOrCreateAsyncBuffer(sessionId);
          if (buffer.settleTimer) {
            clearTimeout(buffer.settleTimer);
            buffer.settleTimer = null;
          }
          const needsBreak =
            !buffer.lastEventWasThought &&
            buffer.thoughtText.length > 0 &&
            !buffer.thoughtText.endsWith('\n');
          const piece = needsBreak ? `\n\n${update.content.text}` : update.content.text;
          buffer.lastEventWasThought = true;
          buffer.lastEventWasTool = false;
          buffer.thoughtText += piece;
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const buffer = this.getOrCreateAsyncBuffer(sessionId);
        if (buffer.settleTimer) {
          clearTimeout(buffer.settleTimer);
          buffer.settleTimer = null;
        }
        buffer.lastEventWasThought = false;
        buffer.lastEventWasTool = true;
        const existing = buffer.toolEventsMap.get(update.toolCallId);
        const name =
          typeof update.name === 'string' && update.name.trim()
            ? update.name.trim()
            : existing?.name;
        const argsText = serializeBoundedValue(update.rawInput, 800) ?? existing?.argsText;
        const resultText = extractToolResultText(update, 1000) ?? existing?.resultText;
        const event: AcpToolEvent = {
          toolCallId: update.toolCallId,
          label: formatToolLabel(update, existing),
          status: update.status ?? existing?.status ?? 'in_progress',
          kind: update.kind ?? existing?.kind,
          name,
          argsText,
          resultText,
        };
        buffer.toolEventsMap.set(update.toolCallId, event);
        break;
      }
      case 'usage_update': {
        const buffer = this.asyncBuffers.get(sessionId);
        if (!buffer) {
          return;
        }
        buffer.usage.contextUsed = update.used;
        buffer.usage.contextSize = update.size;
        if (buffer.text.trim().length > 0) {
          this.scheduleAsyncSettle(sessionId, buffer, this.asyncSettleAfterUsageMs);
        }
        break;
      }
      default:
        break;
    }
  }

  async initialize(): Promise<acp.InitializeResponse> {
    const { init } = await this.ensureConnected();
    return init;
  }

  getAgentInfo(): acp.Implementation | null {
    return this.agentInfo;
  }

  getCachedModels(): AcpModelOption[] {
    return [...this.cachedModels];
  }

  getCachedThoughtLevels(): AcpThoughtLevelOption[] {
    return [...this.cachedThoughtLevels];
  }

  private mergeCachedConfig(extracted: ExtractedSessionConfig): AcpSessionConfigState {
    if (extracted.availableModels.length > 0) {
      this.cachedModels = extracted.availableModels;
    }
    if (extracted.hasConfigOptions) {
      this.cachedThoughtLevels = extracted.availableThoughtLevels;
    }
    return {
      currentModelId: extracted.currentModelId,
      availableModels: this.getCachedModels(),
      currentThoughtLevel: extracted.currentThoughtLevel,
      availableThoughtLevels: extracted.hasConfigOptions ? extracted.availableThoughtLevels : [],
    };
  }

  async ensureSession(params: EnsureSessionParams): Promise<EnsureSessionResult> {
    const { connection, init } = await this.ensureConnected();
    const systemAppend = this.options.systemPromptAppend ?? FEISHU_SYSTEM_PROMPT_APPEND;
    const meta = systemAppend
      ? { antigravity: { systemPrompt: { append: systemAppend } } }
      : undefined;

    // Fast path: reuse an already-loaded session in this ACP process without triggering
    // `session/load` history replay or tearing down the live conversation update stream.
    if (params.sessionId) {
      const cached = this.loadedSessions.get(params.sessionId);
      if (cached && cached.cwd === params.cwd) {
        let configState: AcpSessionConfigState = {
          currentModelId: cached.currentModelId,
          availableModels:
            cached.availableModels.length > 0 ? cached.availableModels : this.getCachedModels(),
          currentThoughtLevel: cached.currentThoughtLevel,
          availableThoughtLevels: cached.availableThoughtLevels,
        };
        const needsModelSwitch = Boolean(
          params.modelId && params.modelId !== configState.currentModelId,
        );
        const desiredThought = params.thoughtLevel?.trim();
        const canApplyThought =
          Boolean(desiredThought) &&
          (needsModelSwitch ||
            (desiredThought !== configState.currentThoughtLevel &&
              configState.availableThoughtLevels.some(
                (t) => t.id.toLowerCase() === desiredThought!.toLowerCase(),
              )));

        if (needsModelSwitch || canApplyThought) {
          configState = await this.setSessionConfig(cached.sessionId, {
            modelId: needsModelSwitch ? params.modelId : undefined,
            thoughtLevel: canApplyThought ? desiredThought : undefined,
            ignoreUnsupportedModel: true,
            ignoreUnsupportedThoughtLevel: true,
            knownThoughtLevels: configState.availableThoughtLevels,
          });
        }

        return {
          sessionId: cached.sessionId,
          loaded: true,
          currentModeId: cached.currentModeId,
          ...configState,
        };
      }
    }

    let sessionId = params.sessionId;
    let loaded = false;
    let resp: acp.NewSessionResponse | acp.LoadSessionResponse | acp.ResumeSessionResponse | undefined;

    const caps = init.agentCapabilities as
      | (acp.AgentCapabilities & { session_capabilities?: { resume?: unknown } })
      | undefined;
    const supportsResume = Boolean(
      caps?.sessionCapabilities?.resume !== undefined ||
        caps?.session_capabilities?.resume !== undefined,
    );

    if (sessionId && supportsResume) {
      try {
        resp = await connection.agent.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd: params.cwd,
          mcpServers: [],
          _meta: meta,
        });
        loaded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[agy acp] resumeSession(${sessionId}) 失败，将创建新会话: ${msg}`);
        sessionId = undefined;
      }
    } else if (sessionId && init.agentCapabilities?.loadSession) {
      this.replayingSessions.add(sessionId);
      try {
        resp = await connection.agent.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: params.cwd,
          mcpServers: [],
          _meta: meta,
        });
        loaded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[agy acp] loadSession(${sessionId}) 失败，将创建新会话: ${msg}`);
        sessionId = undefined;
      } finally {
        this.replayingSessions.delete(params.sessionId!);
      }
    }

    if (!sessionId || !resp) {
      const created = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: params.cwd,
        mcpServers: [],
        _meta: meta,
      });
      sessionId = created.sessionId;
      resp = created;
      loaded = false;
    }

    // Best-effort switch to 'auto' mode (combined with --dangerously-skip-permissions + auto-approve callback)
    let currentModeId = resp.modes?.currentModeId;
    const supportsAuto = resp.modes?.availableModes.some((m) => m.id === 'auto');
    if (supportsAuto && currentModeId !== 'auto') {
      try {
        await connection.agent.request(acp.methods.agent.session.setMode, {
          sessionId,
          modeId: 'auto',
        });
        currentModeId = 'auto';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[agy acp] setMode(auto) 忽略: ${msg}`);
      }
    }

    let configState = this.mergeCachedConfig(extractConfigFromSessionResponse(resp));
    this.loadedSessions.set(sessionId, {
      sessionId,
      cwd: params.cwd,
      currentModeId,
      ...configState,
    });

    const needsModelSwitch = Boolean(params.modelId && params.modelId !== configState.currentModelId);
    const desiredThought = params.thoughtLevel?.trim();
    const canApplyThought =
      Boolean(desiredThought) &&
      (needsModelSwitch ||
        (desiredThought !== configState.currentThoughtLevel &&
          configState.availableThoughtLevels.some(
            (t) => t.id.toLowerCase() === desiredThought!.toLowerCase(),
          )));

    if (needsModelSwitch || canApplyThought) {
      configState = await this.setSessionConfig(sessionId, {
        modelId: needsModelSwitch ? params.modelId : undefined,
        thoughtLevel: canApplyThought ? desiredThought : undefined,
        ignoreUnsupportedModel: true,
        ignoreUnsupportedThoughtLevel: true,
        knownThoughtLevels: configState.availableThoughtLevels,
      });
    }

    this.loadedSessions.set(sessionId, {
      sessionId,
      cwd: params.cwd,
      currentModeId,
      ...configState,
    });

    return {
      sessionId,
      loaded,
      currentModeId,
      ...configState,
    };
  }

  async setSessionConfig(
    sessionId: string,
    params: {
      modelId?: string;
      thoughtLevel?: string;
      knownThoughtLevels?: AcpThoughtLevelOption[];
      ignoreUnsupportedModel?: boolean;
      ignoreUnsupportedThoughtLevel?: boolean;
    },
  ): Promise<AcpSessionConfigState> {
    const { connection } = await this.ensureConnected();
    const existing = this.loadedSessions.get(sessionId);
    let thoughtLevelsKnown = params.knownThoughtLevels !== undefined;
    let state: AcpSessionConfigState = {
      currentModelId: existing?.currentModelId,
      availableModels: this.getCachedModels(),
      currentThoughtLevel: existing?.currentThoughtLevel,
      availableThoughtLevels: params.knownThoughtLevels ?? this.getCachedThoughtLevels(),
    };

    if (params.modelId) {
      const requestedModel = params.modelId.trim();
      let resolvedModelId = requestedModel;
      let skipModelSwitch = false;
      if (state.availableModels.length > 0) {
        const matchedModel = state.availableModels.find(
          (m) => m.id.toLowerCase() === requestedModel.toLowerCase(),
        );
        if (!matchedModel) {
          if (params.ignoreUnsupportedModel) {
            this.log(
              `[agy acp] 忽略已失效的持久化模型 "${requestedModel}"，保持当前默认模型 ${state.currentModelId ?? '(default)'}`,
            );
            skipModelSwitch = true;
          } else {
            throw new Error(
              `未知模型 "${requestedModel}"。可用模型：${state.availableModels.map((m) => m.id).join(', ')}`,
            );
          }
        } else {
          resolvedModelId = matchedModel.id;
        }
      }
      if (!skipModelSwitch) {
        try {
          const res = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: 'model',
            value: resolvedModelId,
          });
          const extracted = extractConfigFromSessionResponse(res);
          thoughtLevelsKnown = extracted.hasConfigOptions;
          state = this.mergeCachedConfig(extracted);
        } catch (err) {
          if (!params.ignoreUnsupportedModel) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`[agy acp] 忽略不可用的模型 "${resolvedModelId}": ${msg}`);
        }
      }
    }

    if (params.thoughtLevel) {
      const requestedThought = params.thoughtLevel.trim();
      const levels = state.availableThoughtLevels;
      const matched = levels.find(
        (t) => t.id.toLowerCase() === requestedThought.toLowerCase(),
      );
      const modelSuffix = state.currentModelId ? ` ${state.currentModelId}` : '';
      if (thoughtLevelsKnown && levels.length === 0) {
        if (!params.ignoreUnsupportedThoughtLevel) {
          throw new Error(`当前模型${modelSuffix}不支持设置思考强度。`);
        }
        return state;
      }
      if (levels.length > 0 && !matched) {
        if (!params.ignoreUnsupportedThoughtLevel) {
          throw new Error(
            `当前模型${modelSuffix}不支持思考强度 "${requestedThought}"。可选值：${levels.map((t) => t.id).join(', ')}`,
          );
        }
        return state;
      }

      const targetThought = matched ? matched.id : requestedThought;
      if (
        state.currentThoughtLevel &&
        state.currentThoughtLevel.toLowerCase() === targetThought.toLowerCase()
      ) {
        return state;
      }

      try {
        const res = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'thought_level',
          value: targetThought,
        });
        state = this.mergeCachedConfig(extractConfigFromSessionResponse(res));
      } catch (err) {
        if (!params.ignoreUnsupportedThoughtLevel) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[agy acp] 忽略不兼容的思考强度 "${targetThought}": ${msg}`);
      }
    }

    const existingSession = this.loadedSessions.get(sessionId);
    if (existingSession) {
      this.loadedSessions.set(sessionId, {
        ...existingSession,
        ...state,
      });
    }

    return state;
  }

  async setModel(sessionId: string, modelId: string): Promise<string> {
    const state = await this.setSessionConfig(sessionId, { modelId });
    return state.currentModelId ?? modelId;
  }

  async prompt(
    sessionId: string,
    blocks: acp.ContentBlock[],
    handlers: AcpPromptHandlers = {},
  ): Promise<AcpPromptResult> {
    const { connection } = await this.ensureConnected();
    this.clearAsyncBuffer(sessionId);
    const collector: ActiveTurnCollector = {
      text: '',
      thoughtText: '',
      lastEventWasThought: false,
      lastEventWasTool: false,
      toolEventsMap: new Map(),
      usage: {},
      handlers,
      steerSeq: 0,
    };
    this.activeCollectors.set(sessionId, collector);

    try {
      let activePromise = connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: blocks,
      });
      collector.currentPromptPromise = activePromise;

      let response: acp.PromptResponse;
      while (true) {
        let settledResponse: acp.PromptResponse | undefined;
        let settledError: unknown;
        let failed = false;
        try {
          settledResponse = await activePromise;
        } catch (err) {
          failed = true;
          settledError = err;
        }

        // If `steer()` replaced `currentPromptPromise` while we were awaiting `activePromise`,
        // `agy acp` resolves the previous prompt early and continues streaming on the new prompt.
        if (collector.currentPromptPromise && collector.currentPromptPromise !== activePromise) {
          activePromise = collector.currentPromptPromise;
          continue;
        }

        if (failed) {
          throw settledError;
        }
        response = settledResponse!;
        break;
      }

      const respObj = response as acp.PromptResponse & {
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          thoughtTokens?: number;
          totalTokens?: number;
        };
      };
      if (respObj.usage) {
        collector.usage.inputTokens = respObj.usage.inputTokens;
        collector.usage.outputTokens = respObj.usage.outputTokens;
        collector.usage.thoughtTokens = respObj.usage.thoughtTokens;
        collector.usage.totalTokens = respObj.usage.totalTokens;
      }

      return {
        stopReason: response.stopReason,
        text: collector.text,
        thoughtText: collector.thoughtText,
        toolEvents: Array.from(collector.toolEventsMap.values()),
        usage: collector.usage,
      };
    } finally {
      if (this.activeCollectors.get(sessionId) === collector) {
        this.activeCollectors.delete(sessionId);
      }
    }
  }

  /**
   * Injects a steering prompt into an already-running `prompt()` turn on the same session.
   * Returns `true` if a live turn accepted the steer, or `false` if no turn is active.
   */
  async steer(sessionId: string, blocks: acp.ContentBlock[]): Promise<boolean> {
    const collector = this.activeCollectors.get(sessionId);
    if (!collector || !this.connection) {
      return false;
    }

    // Prevent unhandled rejections if the superseded prompt fails after handover.
    collector.currentPromptPromise?.catch(() => undefined);

    collector.steerSeq += 1;
    if (collector.text.length > 0) {
      collector.lastEventWasTool = true;
    }

    const nextPromise = this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: blocks,
    });
    // Guard against rejections arriving before the active prompt loop switches to `nextPromise`.
    nextPromise.catch(() => undefined);
    collector.currentPromptPromise = nextPromise;
    return true;
  }

  async cancel(sessionId: string): Promise<void> {
    this.clearAsyncBuffer(sessionId);
    if (!this.connection) {
      return;
    }
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    this.clearAsyncBuffer(sessionId);
    this.loadedSessions.delete(sessionId);
    this.replayingSessions.delete(sessionId);
    if (!this.connection) {
      return;
    }
    try {
      await this.connection.agent.request(acp.methods.agent.session.close, {
        sessionId,
      });
    } catch {
      // Closing already-gone sessions is harmless.
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    const conn = this.connection;
    this.clearProcessState();

    if (conn) {
      conn.close();
    }
    if (!child || child.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        resolve();
      }, 2000);

      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      child.kill('SIGTERM');
    });
  }
}
