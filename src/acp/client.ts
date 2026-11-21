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

interface ActiveTurnCollector {
  text: string;
  thoughtText: string;
  toolEventsMap: Map<string, AcpToolEvent>;
  usage: AcpUsageSummary;
  handlers: AcpPromptHandlers;
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

function extractConfigFromSessionResponse(resp: unknown): AcpSessionConfigState {
  if (!resp || typeof resp !== 'object') {
    return { availableModels: [], availableThoughtLevels: [] };
  }
  const obj = resp as Record<string, unknown>;
  let availableModels: AcpModelOption[] = [];
  let currentModelId: string | undefined;
  let availableThoughtLevels: AcpThoughtLevelOption[] = [];
  let currentThoughtLevel: string | undefined;

  if (Array.isArray(obj.configOptions)) {
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
  };
}

export class AgyAcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientConnection | null = null;
  private initPromise: Promise<acp.InitializeResponse> | null = null;
  private agentInfo: acp.Implementation | null = null;
  private cachedModels: AcpModelOption[] = [];
  private cachedThoughtLevels: AcpThoughtLevelOption[] = [];
  private activeCollectors = new Map<string, ActiveTurnCollector>();
  private shuttingDown = false;

  constructor(
    private readonly options: {
      agyBin: string;
      defaultCwd: string;
      systemPromptAppend?: string;
      logger?: (msg: string) => void;
    },
  ) {}

  private log(msg: string): void {
    this.options.logger?.(msg);
  }

  private clearProcessState(): void {
    this.connection = null;
    this.child = null;
    this.initPromise = null;
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
    const collector = this.activeCollectors.get(notification.sessionId);
    if (!collector) {
      return;
    }

    const { update } = notification;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type === 'text' && update.content.text) {
          collector.text += update.content.text;
          collector.handlers.onTextChunk?.(collector.text, update.content.text);
        }
        break;
      }
      case 'agent_thought_chunk': {
        if (update.content.type === 'text' && update.content.text) {
          collector.thoughtText += update.content.text;
          collector.handlers.onThoughtChunk?.(collector.thoughtText, update.content.text);
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const existing = collector.toolEventsMap.get(update.toolCallId);
        const event: AcpToolEvent = {
          toolCallId: update.toolCallId,
          label: formatToolLabel(update, existing),
          status: update.status ?? existing?.status ?? 'in_progress',
          kind: update.kind ?? existing?.kind,
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

  private mergeCachedConfig(extracted: AcpSessionConfigState): AcpSessionConfigState {
    if (extracted.availableModels.length > 0) {
      this.cachedModels = extracted.availableModels;
    }
    if (extracted.availableThoughtLevels.length > 0) {
      this.cachedThoughtLevels = extracted.availableThoughtLevels;
    }
    return {
      currentModelId: extracted.currentModelId,
      availableModels: this.getCachedModels(),
      currentThoughtLevel: extracted.currentThoughtLevel,
      availableThoughtLevels:
        extracted.availableThoughtLevels.length > 0
          ? extracted.availableThoughtLevels
          : this.getCachedThoughtLevels(),
    };
  }

  async ensureSession(params: EnsureSessionParams): Promise<EnsureSessionResult> {
    const { connection, init } = await this.ensureConnected();
    const systemAppend = this.options.systemPromptAppend ?? FEISHU_SYSTEM_PROMPT_APPEND;
    const meta = systemAppend
      ? { antigravity: { systemPrompt: { append: systemAppend } } }
      : undefined;

    let sessionId = params.sessionId;
    let loaded = false;
    let resp: acp.NewSessionResponse | acp.LoadSessionResponse | undefined;

    if (sessionId && init.agentCapabilities?.loadSession) {
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

    const needsModelSwitch = Boolean(params.modelId && params.modelId !== configState.currentModelId);
    const desiredThought = params.thoughtLevel?.trim();
    const canApplyThought =
      Boolean(desiredThought && desiredThought !== configState.currentThoughtLevel) &&
      (needsModelSwitch ||
        configState.availableThoughtLevels.length === 0 ||
        configState.availableThoughtLevels.some(
          (t) => t.id.toLowerCase() === desiredThought!.toLowerCase(),
        ));

    if (needsModelSwitch || canApplyThought) {
      configState = await this.setSessionConfig(sessionId, {
        modelId: needsModelSwitch ? params.modelId : undefined,
        thoughtLevel: desiredThought && (!needsModelSwitch || canApplyThought) ? desiredThought : undefined,
        ignoreUnsupportedThoughtLevel: true,
        knownThoughtLevels: configState.availableThoughtLevels,
      });
    }

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
      ignoreUnsupportedThoughtLevel?: boolean;
    },
  ): Promise<AcpSessionConfigState> {
    const { connection } = await this.ensureConnected();
    let state: AcpSessionConfigState = {
      availableModels: this.getCachedModels(),
      availableThoughtLevels: params.knownThoughtLevels ?? this.getCachedThoughtLevels(),
    };

    if (params.modelId) {
      const requestedModel = params.modelId.trim();
      let resolvedModelId = requestedModel;
      if (state.availableModels.length > 0) {
        const matchedModel = state.availableModels.find(
          (m) => m.id.toLowerCase() === requestedModel.toLowerCase(),
        );
        if (!matchedModel) {
          throw new Error(
            `未知模型 "${requestedModel}"。可用模型：${state.availableModels.map((m) => m.id).join(', ')}`,
          );
        }
        resolvedModelId = matchedModel.id;
      }
      const res = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: resolvedModelId,
      });
      state = this.mergeCachedConfig(extractConfigFromSessionResponse(res));
    }

    if (params.thoughtLevel) {
      const requestedThought = params.thoughtLevel.trim();
      const levels = state.availableThoughtLevels;
      const matched = levels.find(
        (t) => t.id.toLowerCase() === requestedThought.toLowerCase(),
      );
      if (levels.length > 0 && !matched) {
        if (!params.ignoreUnsupportedThoughtLevel) {
          throw new Error(
            `当前模型 ${state.currentModelId ?? ''} 不支持思考强度 "${requestedThought}"。可选值：${levels.map((t) => t.id).join(', ')}`,
          );
        }
        return state;
      }

      const res = await connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'thought_level',
        value: matched ? matched.id : requestedThought,
      });
      state = this.mergeCachedConfig(extractConfigFromSessionResponse(res));
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
    const collector: ActiveTurnCollector = {
      text: '',
      thoughtText: '',
      toolEventsMap: new Map(),
      usage: {},
      handlers,
    };
    this.activeCollectors.set(sessionId, collector);

    try {
      const response = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: blocks,
      });

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
      this.activeCollectors.delete(sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.connection) {
      return;
    }
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  async closeSession(sessionId: string): Promise<void> {
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
