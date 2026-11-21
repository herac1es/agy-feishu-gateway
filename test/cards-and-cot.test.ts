import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AcpPromptHandlers, AcpPromptResult, AgyAcpClient } from '../src/acp/client.js';
import type { GatewayConfig } from '../src/config.js';
import {
  buildFinalCard,
  buildRunningCard,
  CARD_ELEMENT_IDS,
  SAFE_CARD_JSON_BYTES,
  truncateUtf8Head,
  truncateUtf8Tail,
} from '../src/feishu/cards.js';
import {
  isCardKitPermissionError,
  type FeishuCotEvent,
  type FeishuGatewayClient,
  type FeishuMessageCotHandle,
  type FeishuRawMessageReceiveEvent,
  type FeishuSendTarget,
} from '../src/feishu/client.js';
import {
  COT_MAX_EVENT_CONTENT_CHARS,
  FeishuNativeCotSession,
  resolveCotToolIcon,
} from '../src/feishu/cot.js';
import { FeishuAcpGateway } from '../src/gateway.js';

function getBodyElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
  return body?.elements ?? [];
}

function findElement(
  elements: Array<Record<string, unknown>>,
  id: string,
): Record<string, unknown> | undefined {
  for (const el of elements) {
    if (el.element_id === id) return el;
    if (Array.isArray(el.elements)) {
      const nested = findElement(el.elements as Array<Record<string, unknown>>, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

describe('Feishu Card JSON 2.0 CoT cards', () => {
  it('renders expanded CoT collapsible_panel while thinking and auto-collapses when reply starts', () => {
    const thinkingCard = buildRunningCard({
      statusText: '推理规划中…',
      thoughtText: '先检查配置文件，再确认端口映射。',
      thoughtElapsedMs: 1800,
      toolLines: ['⚙️ read_file: src/config.ts'],
      toolCount: 1,
      partialText: '',
      cwd: '/tmp/demo',
      modelId: 'gemini-4-neon',
      thoughtLevel: 'high',
    });

    assert.equal(thinkingCard.schema, '2.0');
    assert.equal((thinkingCard.config as { update_multi?: boolean }).update_multi, true);
    assert.equal(thinkingCard.elements, undefined);

    const els = getBodyElements(thinkingCard);
    const cotPanel = findElement(els, CARD_ELEMENT_IDS.cotPanel);
    const cotMd = findElement(els, CARD_ELEMENT_IDS.cotMarkdown);
    assert.ok(cotPanel);
    assert.equal(cotPanel.tag, 'collapsible_panel');
    assert.equal(cotPanel.expanded, true);
    assert.equal(cotPanel.padding, '8px 10px 8px 10px');
    assert.equal((cotPanel.header as { padding?: string }).padding, '4px 8px 4px 8px');
    assert.ok(cotMd && typeof cotMd.content === 'string');
    assert.ok(cotMd.content.includes('先检查配置文件'));
    assert.ok(cotMd.content.includes('read_file: src/config.ts'));
    assert.equal(findElement(els, CARD_ELEMENT_IDS.replyMarkdown), undefined);

    const replyingCard = buildRunningCard({
      statusText: '正在生成回复…',
      thoughtText: '先检查配置文件，再确认端口映射。',
      thoughtElapsedMs: 2400,
      toolLines: ['✅ read_file: src/config.ts'],
      toolCount: 1,
      partialText: '已定位问题，正在修复。',
      cwd: '/tmp/demo',
      modelId: 'gemini-4-neon',
      thoughtLevel: 'high',
    });

    const replyingEls = getBodyElements(replyingCard);
    const collapsedPanel = findElement(replyingEls, CARD_ELEMENT_IDS.cotPanel);
    const replyMd = findElement(replyingEls, CARD_ELEMENT_IDS.replyMarkdown);
    assert.equal(collapsedPanel?.expanded, false);
    assert.equal(replyMd?.content, '已定位问题，正在修复。');
  });

  it('builds CardKit streaming skeleton with streaming_mode=true and reply element ready', () => {
    const card = buildRunningCard({
      statusText: '正在连接 Antigravity 会话…',
      thoughtText: '',
      toolLines: [],
      toolCount: 0,
      partialText: '',
      cwd: '/tmp/demo',
      streamingMode: true,
    });

    const cfg = card.config as { streaming_mode?: boolean; streaming_config?: unknown };
    assert.equal(cfg.streaming_mode, true);
    assert.ok(cfg.streaming_config);

    const els = getBodyElements(card);
    assert.ok(findElement(els, CARD_ELEMENT_IDS.cotPanel));
    assert.ok(findElement(els, CARD_ELEMENT_IDS.cotMarkdown));
    assert.ok(findElement(els, CARD_ELEMENT_IDS.replyMarkdown));
    assert.ok(findElement(els, CARD_ELEMENT_IDS.metaMarkdown));
  });

  it('collapses CoT panel on final card, omits panel when empty, and enforces 30KB byte budget', () => {
    const finalWithCot = buildFinalCard({
      status: 'completed',
      text: '最终结论：已接入飞书 CoT 折叠面板。',
      thoughtText: '1. 分析现状\n2. 设计 Card 2.0 折叠面板',
      thoughtElapsedMs: 3200,
      elapsedMs: 5100,
      cwd: '/tmp/demo',
      modelId: 'gemini-4-neon',
      thoughtLevel: 'high',
      toolEvents: [{ toolCallId: 't1', label: 'read_file: src/gateway.ts', status: 'completed' }],
      usage: { inputTokens: 100, outputTokens: 50, thoughtTokens: 40, totalTokens: 190 },
      forCardKit: true,
    });

    assert.equal(finalWithCot.schema, '2.0');
    assert.equal((finalWithCot.config as { streaming_mode?: boolean }).streaming_mode, false);
    const els = getBodyElements(finalWithCot);
    const panel = findElement(els, CARD_ELEMENT_IDS.cotPanel);
    const cotMd = findElement(els, CARD_ELEMENT_IDS.cotMarkdown);
    const replyMd = findElement(els, CARD_ELEMENT_IDS.replyMarkdown);
    const metaMd = findElement(els, CARD_ELEMENT_IDS.metaMarkdown);
    assert.equal(panel?.expanded, false);
    assert.ok(String((panel?.header as { title?: { content?: string } })?.title?.content).includes('3.2s'));
    assert.ok(String(cotMd?.content).includes('设计 Card 2.0 折叠面板'));
    assert.ok(String(cotMd?.content).includes('read_file: src/gateway.ts'));
    assert.equal(replyMd?.content, '最终结论：已接入飞书 CoT 折叠面板。');
    assert.ok(String(metaMd?.content).includes('thought 40'));

    const finalNoCot = buildFinalCard({
      status: 'completed',
      text: 'PONG',
      elapsedMs: 300,
      cwd: '/tmp/demo',
    });
    assert.equal(findElement(getBodyElements(finalNoCot), CARD_ELEMENT_IDS.cotPanel), undefined);

    // Oversized thought text + code fence must stay within SAFE_CARD_JSON_BYTES and close code fences.
    const hugeThought = '```ts\n' + '思考推理日志内容，'.repeat(4000) + '\n```';
    const boundedCard = buildFinalCard({
      status: 'completed',
      text: '正文内容，'.repeat(1500),
      thoughtText: hugeThought,
      thoughtElapsedMs: 12_000,
      elapsedMs: 15_000,
      cwd: '/tmp/demo',
    });
    const payloadBytes = Buffer.byteLength(JSON.stringify(boundedCard), 'utf8');
    assert.ok(
      payloadBytes <= SAFE_CARD_JSON_BYTES,
      `Expected card bytes ${payloadBytes} <= ${SAFE_CARD_JSON_BYTES}`,
    );

    const headCut = truncateUtf8Head('```js\nconst x = 1;\n'.repeat(50), 180);
    const fenceCount = (headCut.match(/```/g) ?? []).length;
    assert.equal(fenceCount % 2, 0);

    const tailCut = truncateUtf8Tail('前面文字\n'.repeat(100) + '```js\nconst y = 2;', 180);
    assert.equal(((tailCut.match(/```/g) ?? []).length) % 2, 0);
  });

  it('detects Feishu cardkit:card:write permission errors', () => {
    assert.equal(
      isCardKitPermissionError({ response: { data: { code: 99991672, msg: 'Access denied' } } }),
      true,
    );
    assert.equal(
      isCardKitPermissionError(new Error('missing scope cardkit:card:write')),
      true,
    );
    assert.equal(isCardKitPermissionError(new Error('network timeout')), false);
  });
});

describe('FeishuAcpGateway CoT streaming & fallback orchestration', () => {
  function makeConfig(dataDir: string): GatewayConfig {
    return {
      rootDir: dataDir,
      envFile: path.join(dataDir, '.env'),
      feishuAppId: 'cli_test',
      feishuAppSecret: 'sec_test',
      feishuDomain: 'feishu',
      groupRequireMention: false,
      defaultCwd: dataDir,
      agyBin: 'agy',
      dataDir,
      lockDir: path.join(dataDir, 'locks'),
      cardUpdateIntervalMs: 10,
      version: '0.1.0',
      releaseId: 'test',
    };
  }

  function makeInboundEvent(messageId: string, text: string): FeishuRawMessageReceiveEvent {
    return {
      event_id: `evt_${messageId}`,
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
      message: {
        message_id: messageId,
        create_time: String(Date.now()),
        chat_id: 'oc_p2p_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    };
  }

  it('streams CoT and reply via CardKit v1 with strictly increasing sequence and closes streaming_mode', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cot-cardkit-'));
    try {
      const calls: Array<{ op: string; seq?: number; elementId?: string; payload?: unknown }> = [];
      let receivedHandler: ((ev: FeishuRawMessageReceiveEvent) => Promise<void>) = async () => {
        throw new Error('WebSocket handler was not registered');
      };

      const fakeFeishu = {
        getBotInfo: async () => ({ appName: 'TestBot', openId: 'ou_bot' }),
        startWebSocket: async (onMsg: (ev: FeishuRawMessageReceiveEvent) => Promise<void>) => {
          receivedHandler = onMsg;
        },
        stopWebSocket: () => undefined,
        getMessage: async () => null,
        downloadMessageResource: async () => '',
        createMessageCot: async () => {
          throw new Error('native message_cot disabled in CardKit fallback test');
        },
        createCardEntity: async (card: Record<string, unknown>) => {
          calls.push({ op: 'createCardEntity', payload: card });
          return 'card_ent_1';
        },
        sendCardEntity: async (_target: unknown, cardId: string) => {
          calls.push({ op: 'sendCardEntity', payload: cardId });
          return 'om_card_1';
        },
        streamCardElementContent: async (
          _cardId: string,
          elementId: string,
          content: string,
          seq: number,
        ) => {
          calls.push({ op: 'streamContent', elementId, seq, payload: content });
        },
        patchCardElement: async (
          _cardId: string,
          elementId: string,
          partial: Record<string, unknown>,
          seq: number,
        ) => {
          calls.push({ op: 'patchElement', elementId, seq, payload: partial });
        },
        updateCardSettings: async (
          _cardId: string,
          settings: Record<string, unknown>,
          seq: number,
        ) => {
          calls.push({ op: 'updateSettings', seq, payload: settings });
        },
        updateCardEntity: async (
          _cardId: string,
          card: Record<string, unknown>,
          seq: number,
        ) => {
          calls.push({ op: 'updateEntity', seq, payload: card });
        },
        sendCard: async () => {
          throw new Error('sendCard should not be called when CardKit succeeds');
        },
        patchCard: async () => {
          throw new Error('patchCard should not be called when CardKit succeeds');
        },
      } as unknown as FeishuGatewayClient;

      const fakeAcp = {
        initialize: async () => ({ protocolVersion: 1, agentInfo: { name: 'agy', version: '1.0' } }),
        shutdown: async () => undefined,
        ensureSession: async () => ({
          sessionId: 'sess_1',
          loaded: false,
          currentModelId: 'gemini-4-neon',
          currentThoughtLevel: 'high',
          availableModels: [],
          availableThoughtLevels: [],
        }),
        prompt: async (
          _sessionId: string,
          _blocks: unknown,
          handlers: AcpPromptHandlers,
        ): Promise<AcpPromptResult> => {
          handlers.onThoughtChunk?.('第一步：定位 gateway.ts', '第一步：定位 gateway.ts');
          await new Promise((r) => setTimeout(r, 30));
          handlers.onToolEvent?.(
            { toolCallId: 't1', label: 'read_file: src/gateway.ts', status: 'completed' },
            [{ toolCallId: 't1', label: 'read_file: src/gateway.ts', status: 'completed' }],
          );
          await new Promise((r) => setTimeout(r, 30));
          handlers.onTextChunk?.('最终回复内容', '最终回复内容');
          await new Promise((r) => setTimeout(r, 30));
          return {
            stopReason: 'end_turn',
            text: '最终回复内容',
            thoughtText: '第一步：定位 gateway.ts',
            toolEvents: [{ toolCallId: 't1', label: 'read_file: src/gateway.ts', status: 'completed' }],
            usage: { totalTokens: 123 },
          };
        },
      } as unknown as AgyAcpClient;

      const gateway = new FeishuAcpGateway(makeConfig(tmpDir), fakeFeishu, fakeAcp);
      await gateway.start();

      await receivedHandler(makeInboundEvent('om_in_1', '帮我接入 COT'));

      const seqs = calls.filter((c) => typeof c.seq === 'number').map((c) => c.seq!);
      assert.ok(seqs.length >= 4, `Expected >= 4 sequenced CardKit calls, got ${seqs.length}`);
      for (let i = 1; i < seqs.length; i += 1) {
        assert.ok(seqs[i] > seqs[i - 1], `Sequence not strictly increasing: ${seqs.join(',')}`);
      }

      assert.ok(
        calls.some(
          (c) =>
            c.op === 'streamContent' &&
            c.elementId === CARD_ELEMENT_IDS.cotMarkdown &&
            String(c.payload).includes('第一步：定位 gateway.ts'),
        ),
      );
      assert.ok(
        calls.some(
          (c) =>
            c.op === 'patchElement' &&
            c.elementId === CARD_ELEMENT_IDS.cotPanel &&
            (c.payload as { expanded?: boolean }).expanded === false,
        ),
      );
      assert.ok(
        calls.some(
          (c) =>
            c.op === 'streamContent' &&
            c.elementId === CARD_ELEMENT_IDS.replyMarkdown &&
            c.payload === '最终回复内容',
        ),
      );

      const settingsCall = calls.find((c) => c.op === 'updateSettings');
      assert.ok(settingsCall);
      assert.equal(
        (settingsCall.payload as { config?: { streaming_mode?: boolean } }).config?.streaming_mode,
        false,
      );

      const finalCall = calls.find((c) => c.op === 'updateEntity');
      assert.ok(finalCall);
      const finalCard = finalCall.payload as Record<string, unknown>;
      assert.equal(finalCard.schema, '2.0');
      const finalPanel = findElement(getBodyElements(finalCard), CARD_ELEMENT_IDS.cotPanel);
      assert.equal(finalPanel?.expanded, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('gracefully falls back to Card 2.0 sendCard + patchCard when cardkit:card:write is missing and caches cooldown', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cot-fallback-'));
    try {
      let createCardAttempts = 0;
      const sentCards: Array<Record<string, unknown>> = [];
      const patchedCards: Array<Record<string, unknown>> = [];
      let receivedHandler: ((ev: FeishuRawMessageReceiveEvent) => Promise<void>) = async () => {
        throw new Error('WebSocket handler was not registered');
      };

      const fakeFeishu = {
        getBotInfo: async () => ({ appName: 'TestBot', openId: 'ou_bot' }),
        startWebSocket: async (onMsg: (ev: FeishuRawMessageReceiveEvent) => Promise<void>) => {
          receivedHandler = onMsg;
        },
        stopWebSocket: () => undefined,
        getMessage: async () => null,
        downloadMessageResource: async () => '',
        createMessageCot: async () => {
          throw new Error('native message_cot disabled in patchCard fallback test');
        },
        createCardEntity: async () => {
          createCardAttempts += 1;
          throw { response: { data: { code: 99991672, msg: 'cardkit:card:write required' } } };
        },
        sendCard: async (_target: unknown, card: Record<string, unknown>) => {
          sentCards.push(card);
          return `om_sent_${sentCards.length}`;
        },
        patchCard: async (_msgId: string, card: Record<string, unknown>) => {
          patchedCards.push(card);
        },
      } as unknown as FeishuGatewayClient;

      const fakeAcp = {
        initialize: async () => ({ protocolVersion: 1, agentInfo: { name: 'agy', version: '1.0' } }),
        shutdown: async () => undefined,
        ensureSession: async () => ({
          sessionId: 'sess_fb',
          loaded: false,
          availableModels: [],
          availableThoughtLevels: [],
        }),
        prompt: async (
          _sessionId: string,
          _blocks: unknown,
          handlers: AcpPromptHandlers,
        ): Promise<AcpPromptResult> => {
          handlers.onThoughtChunk?.('正在分析降级路径', '正在分析降级路径');
          await new Promise((r) => setTimeout(r, 25));
          handlers.onTextChunk?.('降级模式完成回复', '降级模式完成回复');
          return {
            stopReason: 'end_turn',
            text: '降级模式完成回复',
            thoughtText: '正在分析降级路径',
            toolEvents: [],
            usage: {},
          };
        },
      } as unknown as AgyAcpClient;

      const gateway = new FeishuAcpGateway(makeConfig(tmpDir), fakeFeishu, fakeAcp);
      await gateway.start();

      await receivedHandler(makeInboundEvent('om_fb_1', '第一次提问'));
      await receivedHandler(makeInboundEvent('om_fb_2', '第二次提问'));

      // Permission error cooldown prevents retrying createCardEntity on turn 2.
      assert.equal(createCardAttempts, 1);
      assert.equal(sentCards.length, 2);
      assert.ok(patchedCards.length >= 2);

      // Final patched card has schema 2.0 + collapsed CoT panel containing thought text.
      const lastPatched = patchedCards[patchedCards.length - 1];
      assert.equal(lastPatched.schema, '2.0');
      const cotPanel = findElement(getBodyElements(lastPatched), CARD_ELEMENT_IDS.cotPanel);
      const cotMd = findElement(getBodyElements(lastPatched), CARD_ELEMENT_IDS.cotMarkdown);
      const replyMd = findElement(getBodyElements(lastPatched), CARD_ELEMENT_IDS.replyMarkdown);
      assert.equal(cotPanel?.expanded, false);
      assert.ok(String(cotMd?.content).includes('正在分析降级路径'));
      assert.equal(replyMd?.content, '降级模式完成回复');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streams native Feishu message_cot AG-UI events, enforces event length bounds, and sends clean final card', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-cot-'));
    try {
      const createdTargets: FeishuSendTarget[] = [];
      const writtenEvents: FeishuCotEvent[] = [];
      const completedHandles: FeishuMessageCotHandle[] = [];
      const sentCards: Array<Record<string, unknown>> = [];
      let receivedHandler: (ev: FeishuRawMessageReceiveEvent) => Promise<void> = async () => {
        throw new Error('WebSocket handler was not registered');
      };

      const fakeFeishu = {
        getBotInfo: async () => ({ appName: 'TestBot', openId: 'ou_bot' }),
        startWebSocket: async (onMsg: (ev: FeishuRawMessageReceiveEvent) => Promise<void>) => {
          receivedHandler = onMsg;
        },
        stopWebSocket: () => undefined,
        getMessage: async () => null,
        downloadMessageResource: async () => '',
        createMessageCot: async (target: FeishuSendTarget) => {
          createdTargets.push(target);
          return { cotId: 'cot_native_1', messageId: 'om_cot_1' };
        },
        writeMessageCotEvents: async (_handle: FeishuMessageCotHandle, events: FeishuCotEvent[]) => {
          writtenEvents.push(...events);
        },
        completeMessageCot: async (handle: FeishuMessageCotHandle) => {
          completedHandles.push(handle);
        },
        sendCard: async (_target: unknown, card: Record<string, unknown>) => {
          sentCards.push(card);
          return 'om_final_1';
        },
      } as unknown as FeishuGatewayClient;

      const longThought = '深度推理步骤内容，'.repeat(160);
      const fakeAcp = {
        initialize: async () => ({ protocolVersion: 1, agentInfo: { name: 'agy', version: '1.0' } }),
        shutdown: async () => undefined,
        ensureSession: async () => ({
          sessionId: 'sess_native',
          loaded: false,
          currentModelId: 'gemini-4-neon',
          currentThoughtLevel: 'high',
          availableModels: [],
          availableThoughtLevels: [],
        }),
        prompt: async (
          _sessionId: string,
          _blocks: unknown,
          handlers: AcpPromptHandlers,
        ): Promise<AcpPromptResult> => {
          handlers.onThoughtChunk?.(longThought, longThought);
          handlers.onToolEvent?.(
            {
              toolCallId: 'tc_1',
              label: 'read_file: src/gateway.ts',
              name: 'read_file',
              kind: 'read',
              status: 'in_progress',
              argsText: JSON.stringify({ Path: '/repo/src/gateway.ts' }),
            },
            [],
          );
          handlers.onToolEvent?.(
            {
              toolCallId: 'tc_1',
              label: 'read_file: src/gateway.ts',
              name: 'read_file',
              kind: 'read',
              status: 'completed',
              resultText: 'file contents ok',
            },
            [],
          );
          handlers.onTextChunk?.('原生 COT 联调完成。', '原生 COT 联调完成。');
          return {
            stopReason: 'end_turn',
            text: '原生 COT 联调完成。',
            thoughtText: longThought,
            toolEvents: [
              {
                toolCallId: 'tc_1',
                label: 'read_file: src/gateway.ts',
                name: 'read_file',
                kind: 'read',
                status: 'completed',
              },
            ],
            usage: { totalTokens: 200 },
          };
        },
      } as unknown as AgyAcpClient;

      const gateway = new FeishuAcpGateway(makeConfig(tmpDir), fakeFeishu, fakeAcp);
      await gateway.start();

      await receivedHandler(makeInboundEvent('om_native_in_1', '接入原生 COT'));

      // P2P creates native COT inside topic thread.
      assert.equal(createdTargets.length, 1);
      assert.equal(createdTargets[0].replyInThread, true);
      assert.equal(createdTargets[0].replyToMessageId, 'om_native_in_1');

      // Event sequence: RUN_STARTED -> REASONING_* -> TOOL_CALL_* -> RUN_FINISHED.
      const types = writtenEvents.map((e) => e.event_type);
      assert.equal(types[0], 'RUN_STARTED');
      assert.ok(types.includes('REASONING_MESSAGE_START'));
      assert.ok(types.filter((t) => t === 'REASONING_MESSAGE_CONTENT').length >= 2);
      assert.ok(types.includes('REASONING_MESSAGE_END'));
      assert.ok(types.includes('TOOL_CALL_START'));
      assert.ok(types.includes('TOOL_CALL_ARGS'));
      assert.ok(types.includes('TOOL_CALL_END'));
      assert.ok(types.includes('TOOL_CALL_RESULT'));
      assert.equal(types[types.length - 1], 'RUN_FINISHED');

      // Every event content stays within Feishu payload limit, and timestamps strictly increase.
      for (let i = 0; i < writtenEvents.length; i += 1) {
        assert.ok(
          writtenEvents[i].content.length <= COT_MAX_EVENT_CONTENT_CHARS,
          `Event ${i} content length ${writtenEvents[i].content.length} exceeds ${COT_MAX_EVENT_CONTENT_CHARS}`,
        );
        if (i > 0) {
          assert.ok(Number(writtenEvents[i].timestamp) > Number(writtenEvents[i - 1].timestamp));
        }
      }

      // Formal complete endpoint was called.
      assert.deepEqual(completedHandles, [{ cotId: 'cot_native_1', messageId: 'om_cot_1' }]);

      // Only one clean final answer card was sent (no duplicate running card, no duplicate collapsible_panel).
      assert.equal(sentCards.length, 1);
      assert.equal(findElement(getBodyElements(sentCards[0]), CARD_ELEMENT_IDS.cotPanel), undefined);
      assert.equal(
        findElement(getBodyElements(sentCards[0]), CARD_ELEMENT_IDS.replyMarkdown)?.content,
        '原生 COT 联调完成。',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('contains native COT write errors without throwing and resolves tool icons cleanly', async () => {
    assert.equal(resolveCotToolIcon({ kind: 'read', label: 'x' }), 'read');
    assert.equal(resolveCotToolIcon({ kind: 'execute', label: 'x' }), 'bash');
    assert.equal(resolveCotToolIcon({ label: 'edit_file: foo.ts' }), 'write');
    assert.equal(resolveCotToolIcon({ label: 'search_web' }), 'search');

    const session = new FeishuNativeCotSession(
      {
        createMessageCot: async () => ({ cotId: 'cot_err', messageId: 'om_err' }),
        writeMessageCotEvents: async () => {
          throw new Error('simulated 10001 error');
        },
        completeMessageCot: async () => undefined,
      },
      { chatId: 'oc_1' },
      { runId: 'run-err', flushIntervalMs: 10 },
    );

    assert.equal(await session.start(), true);
    session.pushThoughtDelta('some thought');
    await session.finish({ status: 'completed' });
    assert.equal(session.isActive(), false);
  });
});
