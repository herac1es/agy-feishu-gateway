import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgyAcpClient, type AcpAsyncTurnResult, type AcpPromptHandlers } from '../src/acp/client.js';
import type { GatewayConfig } from '../src/config.js';
import type { FeishuGatewayClient, FeishuRawMessageReceiveEvent, FeishuSendTarget } from '../src/feishu/client.js';
import { FeishuAcpGateway } from '../src/gateway.js';

function makeConfig(dataDir: string): GatewayConfig {
  return {
    rootDir: dataDir,
    envFile: path.join(dataDir, '.env'),
    feishuAppId: 'cli_test',
    feishuAppSecret: 'secret_test',
    feishuDomain: 'feishu',
    groupRequireMention: false,
    defaultCwd: dataDir,
    agyBin: 'agy',
    dataDir,
    lockDir: path.join(dataDir, 'locks'),
    cardUpdateIntervalMs: 400,
    version: '0.1.0',
    releaseId: 'test',
  };
}

function makeGroupEvent(messageId: string, text: string): FeishuRawMessageReceiveEvent {
  return {
    event_id: `ev_${messageId}`,
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
    message: {
      message_id: messageId,
      create_time: String(Date.now()),
      chat_id: 'oc_grp_async',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('AgyAcpClient session reuse, resume preference, and unsolicited async turns', () => {
  it('reuses already-loaded sessions without calling session/load or session/resume again, and prefers session/resume on cold reconnect', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new AgyAcpClient({
      agyBin: 'agy',
      defaultCwd: '/tmp',
      asyncSettleAfterUsageMs: 40,
      asyncSettleFallbackMs: 120,
    });

    const fakeConnection = {
      agent: {
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          if (method === 'session/resume' || method === 'session/load') {
            return {
              sessionId: params.sessionId,
              modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }] },
              configOptions: [
                {
                  id: 'model',
                  name: 'Model',
                  category: 'model',
                  type: 'select',
                  currentValue: 'gemini-4-neon',
                  options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
                },
              ],
            };
          }
          if (method === 'session/close') {
            return {};
          }
          throw new Error(`Unexpected method: ${method}`);
        },
        notify: async () => undefined,
      },
      close: () => undefined,
    };

    const internal = client as unknown as {
      connection: unknown;
      initPromise: Promise<unknown>;
    };
    internal.connection = fakeConnection;
    internal.initPromise = Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, load: {}, close: {} },
      },
    });

    // 1. Cold reconnect to existing sessionId must use session/resume (NOT session/load)
    const first = await client.ensureSession({
      cwd: '/tmp/work',
      sessionId: 'sess-existing-1',
    });
    assert.equal(first.sessionId, 'sess-existing-1');
    assert.equal(first.loaded, true);
    assert.deepEqual(
      requests.map((r) => r.method),
      ['session/resume'],
    );

    // 2. Second turn on the same already-loaded session must NOT call session/resume or session/load again
    const second = await client.ensureSession({
      cwd: '/tmp/work',
      sessionId: 'sess-existing-1',
    });
    assert.equal(second.sessionId, 'sess-existing-1');
    assert.equal(second.loaded, true);
    assert.deepEqual(
      requests.map((r) => r.method),
      ['session/resume'],
    );

    await client.closeSession('sess-existing-1');
  });

  it('buffers unsolicited post-prompt session/update notifications and emits onAsyncTurn after settling', async () => {
    const asyncTurns: AcpAsyncTurnResult[] = [];
    const client = new AgyAcpClient({
      agyBin: 'agy',
      defaultCwd: '/tmp',
      asyncSettleAfterUsageMs: 50,
      asyncSettleFallbackMs: 200,
    });
    assert.equal(typeof client.setAsyncTurnHandler, 'function');
    client.setAsyncTurnHandler((ev) => {
      asyncTurns.push(ev);
    });

    const internal = client as unknown as {
      connection: unknown;
      initPromise: Promise<unknown>;
      handleSessionUpdate: (n: unknown) => void;
    };
    internal.connection = {
      agent: {
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === 'session/new') {
            return {
              sessionId: 'sess-async-1',
              modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }] },
              configOptions: [],
            };
          }
          if (method === 'session/prompt') {
            // Simulate interim response while a background command is still in_progress
            internal.handleSessionUpdate({
              sessionId: 'sess-async-1',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'bg-1',
                name: 'run_command',
                title: 'render video',
                status: 'in_progress',
              },
            });
            internal.handleSessionUpdate({
              sessionId: 'sess-async-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '正在后台渲染，稍后发你。' },
              },
            });
            return { stopReason: 'end_turn' };
          }
          if (method === 'session/close') return {};
          throw new Error(`Unexpected method: ${method}`);
        },
        notify: async () => undefined,
      },
      close: () => undefined,
    };
    internal.initPromise = Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    });

    const ensured = await client.ensureSession({ cwd: '/tmp/work' });
    const p1 = await client.prompt(ensured.sessionId, [{ type: 'text', text: 'render' }]);
    assert.equal(p1.text, '正在后台渲染，稍后发你。');
    assert.equal(asyncTurns.length, 0);

    // Later, background task completes and agent wakes up without any session/prompt in flight
    internal.handleSessionUpdate({
      sessionId: 'sess-async-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bg-1',
        name: 'run_command',
        title: 'render video',
        status: 'completed',
      },
    });
    internal.handleSessionUpdate({
      sessionId: 'sess-async-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Checking rendered frames.' },
      },
    });
    internal.handleSessionUpdate({
      sessionId: 'sess-async-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'qa-1',
        name: 'read_file',
        title: 'cover.png',
        status: 'in_progress',
      },
    });
    internal.handleSessionUpdate({
      sessionId: 'sess-async-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'qa-1',
        name: 'read_file',
        title: 'cover.png',
        status: 'completed',
      },
    });
    internal.handleSessionUpdate({
      sessionId: 'sess-async-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '\n\n渲染完成！\n[[feishu-file:/tmp/out/video.mp4]]',
        },
      },
    });
    internal.handleSessionUpdate({
      sessionId: 'sess-async-1',
      update: {
        sessionUpdate: 'usage_update',
        used: 20000,
        size: 1000000,
      },
    });

    await wait(120);
    assert.equal(asyncTurns.length, 1);
    assert.equal(asyncTurns[0].sessionId, 'sess-async-1');
    assert.match(asyncTurns[0].text, /渲染完成/);
    assert.match(asyncTurns[0].text, /\[\[feishu-file:\/tmp\/out\/video\.mp4\]\]/);
    assert.match(asyncTurns[0].thoughtText, /Checking rendered frames/);
    assert.equal(asyncTurns[0].toolEvents.length, 2);

    // Chained second async wakeup should emit a clean second notification without duplicating the first
    internal.handleSessionUpdate({
      sessionId: 'sess-async-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '第二段异步结果' },
      },
    });
    internal.handleSessionUpdate({
      sessionId: 'sess-async-1',
      update: { sessionUpdate: 'usage_update', used: 21000, size: 1000000 },
    });

    await wait(120);
    assert.equal(asyncTurns.length, 2);
    assert.equal(asyncTurns[1].text, '第二段异步结果');
  });

  it('does not trigger onAsyncTurn for history replayed during fallback session/load', async () => {
    const asyncTurns: AcpAsyncTurnResult[] = [];
    const client = new AgyAcpClient({
      agyBin: 'agy',
      defaultCwd: '/tmp',
      asyncSettleAfterUsageMs: 30,
      asyncSettleFallbackMs: 80,
    });
    client.setAsyncTurnHandler((ev) => {
      asyncTurns.push(ev);
    });

    const internal = client as unknown as {
      connection: unknown;
      initPromise: Promise<unknown>;
      handleSessionUpdate: (n: unknown) => void;
    };
    internal.connection = {
      agent: {
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === 'session/load') {
            internal.handleSessionUpdate({
              sessionId: String(params.sessionId),
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'OLD_REPLAYED_HISTORY' },
              },
            });
            internal.handleSessionUpdate({
              sessionId: String(params.sessionId),
              update: { sessionUpdate: 'usage_update', used: 500, size: 10000 },
            });
            return {
              sessionId: params.sessionId,
              modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }] },
              configOptions: [],
            };
          }
          throw new Error(`Unexpected method: ${method}`);
        },
        notify: async () => undefined,
      },
      close: () => undefined,
    };
    internal.initPromise = Promise.resolve({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true }, // no sessionCapabilities.resume
    });

    await client.ensureSession({ cwd: '/tmp/work', sessionId: 'sess-load-fallback' });
    await wait(120);
    assert.equal(asyncTurns.length, 0);
  });
});

describe('FeishuAcpGateway automatic delivery of async follow-up results', () => {
  it('automatically uploads files and sends final card to Feishu when an async turn completes after prompt returns', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feishu-async-deliver-'));
    try {
      const videoPath = path.join(tmpDir, 'ep01.mp4');
      fs.writeFileSync(videoPath, 'fake-mp4-bytes');

      const sentCards: Array<{ target: FeishuSendTarget; card: Record<string, unknown> }> = [];
      const sentFiles: Array<{ target: FeishuSendTarget; filePath: string }> = [];
      let receivedHandler!: (ev: FeishuRawMessageReceiveEvent) => Promise<void>;
      let asyncHandler: ((ev: AcpAsyncTurnResult) => void | Promise<void>) | null = null;

      const fakeFeishu = {
        getBotInfo: async () => ({ openId: 'ou_bot', appName: 'TestBot' }),
        startWebSocket: async (handler: (ev: FeishuRawMessageReceiveEvent) => Promise<void>) => {
          receivedHandler = handler;
        },
        stopWebSocket: () => undefined,
        getMessage: async () => null,
        downloadMessageResource: async () => '',
        createMessageCot: async () => ({ cotId: 'cot_1', messageId: 'om_cot_1' }),
        writeMessageCotEvents: async () => undefined,
        completeMessageCot: async () => undefined,
        sendCard: async (target: FeishuSendTarget, card: Record<string, unknown>) => {
          sentCards.push({ target, card });
          return `om_card_${sentCards.length}`;
        },
        sendLocalFile: async (target: FeishuSendTarget, filePath: string) => {
          sentFiles.push({ target, filePath });
          return { filePath, msgType: 'media' as const, messageId: 'om_media_1', sizeBytes: 14 };
        },
        sendText: async () => 'om_text_1',
      } as unknown as FeishuGatewayClient;

      const fakeAcp = {
        initialize: async () => ({ protocolVersion: 1, agentInfo: { name: 'agy', version: '1.0' } }),
        shutdown: async () => undefined,
        setAsyncTurnHandler: (fn: ((ev: AcpAsyncTurnResult) => void | Promise<void>) | null) => {
          asyncHandler = fn;
        },
        takePendingAsyncTurn: () => null,
        ensureSession: async () => ({
          sessionId: 'sess_gw_async',
          loaded: false,
          currentModelId: 'gemini-4-neon',
          availableModels: [],
          availableThoughtLevels: [],
        }),
        prompt: async (_sid: string, _blocks: unknown, handlers?: AcpPromptHandlers) => {
          handlers?.onTextChunk?.('已启动后台渲染，稍后推送终版。', '已启动后台渲染，稍后推送终版。');
          return {
            stopReason: 'end_turn',
            text: '已启动后台渲染，稍后推送终版。',
            thoughtText: '',
            toolEvents: [],
            usage: {},
          };
        },
      } as unknown as AgyAcpClient;

      const gateway = new FeishuAcpGateway(makeConfig(tmpDir), fakeFeishu, fakeAcp);
      await gateway.start();

      // 1. User triggers turn; agent returns interim response while background task runs
      await receivedHandler(makeGroupEvent('om_user_1', '开始渲染成片'));
      assert.equal(sentCards.length, 1);
      assert.equal(sentFiles.length, 0);

      // 2. Background task finishes later -> ACP emits async follow-up with final text + file directive
      const triggerAsync = asyncHandler as
        | ((ev: AcpAsyncTurnResult) => void | Promise<void>)
        | null;
      assert.ok(triggerAsync, 'gateway must register async turn handler on ACP client');
      await triggerAsync({
        sessionId: 'sess_gw_async',
        text: `后台渲染和验图全部完成！\n[[feishu-file:${videoPath}]]`,
        thoughtText: 'Verified preview frames.',
        toolEvents: [
          { toolCallId: 'bg-1', label: 'pnpm coolbot produce', status: 'completed' },
        ],
        usage: { contextUsed: 25000, contextSize: 1000000 },
        elapsedMs: 4200,
      });

      // Verify automatic file upload + final card delivery to the exact originating Feishu target
      assert.equal(sentFiles.length, 1);
      assert.equal(sentFiles[0].filePath, videoPath);
      assert.equal(sentFiles[0].target.chatId, 'oc_grp_async');
      assert.equal(sentFiles[0].target.replyToMessageId, 'om_user_1');

      assert.equal(sentCards.length, 2);
      const asyncCard = sentCards[1].card;
      const header = asyncCard.header as { title?: { content?: string } };
      assert.match(header.title?.content ?? '', /后台任务完成/);
      const serialized = JSON.stringify(asyncCard);
      assert.match(serialized, /后台渲染和验图全部完成/);
      assert.doesNotMatch(serialized, /\[\[feishu-file:/);
      assert.match(serialized, /ep01\.mp4/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
