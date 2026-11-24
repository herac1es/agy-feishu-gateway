import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgyAcpClient, type AcpPromptHandlers, type AcpPromptResult } from '../src/acp/client.js';
import type { GatewayConfig } from '../src/config.js';
import {
  buildTurnModeChoiceCard,
  buildTurnModeResolvedCard,
  INBOUND_MODE_CHOICE_ACTION,
} from '../src/feishu/cards.js';
import type {
  FeishuCardActionTriggerEvent,
  FeishuCardCallbackResponse,
  FeishuGatewayClient,
  FeishuRawMessageReceiveEvent,
  FeishuSendTarget,
} from '../src/feishu/client.js';
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
      chat_id: 'oc_grp_mode',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

function makeDeferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function extractCallbackButtons(card: Record<string, unknown>): Array<{
  label: string;
  value: Record<string, unknown>;
}> {
  const out: Array<{ label: string; value: Record<string, unknown> }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'button' && Array.isArray(obj.behaviors)) {
      const cb = obj.behaviors.find(
        (b): b is { type: string; value?: Record<string, unknown> } =>
          Boolean(b && typeof b === 'object' && (b as { type?: unknown }).type === 'callback'),
      );
      if (cb?.value) {
        const textObj = obj.text as { content?: string } | undefined;
        out.push({ label: textObj?.content ?? '', value: cb.value });
      }
    }
    for (const v of Object.values(obj)) {
      walk(v);
    }
  };
  walk(card);
  return out;
}

describe('Feishu Card 2.0 running-turn mode choice cards', () => {
  it('builds Card 2.0 choice card with steer, queue, and cancel callback buttons and resolved cards without buttons', () => {
    const choiceCard = buildTurnModeChoiceCard({
      choiceId: 'abc123',
      messagePreview: '顺便把单测也补一下',
      attachmentSummary: '图片 ×1',
      queuedCount: 2,
    });

    assert.equal(choiceCard.schema, '2.0');
    const buttons = extractCallbackButtons(choiceCard);
    assert.equal(buttons.length, 3);
    assert.deepEqual(
      buttons.map((b) => b.value),
      [
        { kind: INBOUND_MODE_CHOICE_ACTION, choiceId: 'abc123', mode: 'steer' },
        { kind: INBOUND_MODE_CHOICE_ACTION, choiceId: 'abc123', mode: 'queue' },
        { kind: INBOUND_MODE_CHOICE_ACTION, choiceId: 'abc123', mode: 'cancel' },
      ],
    );
    const serialized = JSON.stringify(choiceCard);
    assert.match(serialized, /顺便把单测也补一下/);
    assert.match(serialized, /图片 ×1/);
    assert.match(serialized, /已有 \*\*2\*\* 条消息在排队/);

    const resolved = buildTurnModeResolvedCard({
      outcome: 'steered',
      messagePreview: '顺便把单测也补一下',
    });
    assert.equal(resolved.schema, '2.0');
    assert.equal(extractCallbackButtons(resolved).length, 0);
    assert.match(JSON.stringify(resolved), /已切入引导当前任务/);
  });
});

describe('AgyAcpClient.steer() mid-turn prompt handover', () => {
  it('keeps prompt() alive when agy resolves the superseded prompt early, and resolves with final steered output', async () => {
    const client = new AgyAcpClient({ agyBin: 'agy', defaultCwd: '/tmp' });
    const internal = client as unknown as {
      connection: unknown;
      initPromise: Promise<unknown>;
      handleSessionUpdate: (n: unknown) => void;
    };

    const promptDeferreds: Array<ReturnType<typeof makeDeferred<Record<string, unknown>>>> = [];
    const sentPrompts: Array<unknown> = [];

    internal.connection = {
      agent: {
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === 'session/new') {
            return {
              sessionId: 'sess_steer_1',
              modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }] },
              configOptions: [],
            };
          }
          if (method === 'session/prompt') {
            sentPrompts.push(params.prompt);
            const d = makeDeferred<Record<string, unknown>>();
            promptDeferreds.push(d);
            // Emulate real `agy acp`: when a steering prompt arrives while a prior prompt is in flight,
            // `agy acp` resolves the previous prompt immediately with `{ stopReason: 'end_turn' }`.
            if (promptDeferreds.length >= 2) {
              promptDeferreds[promptDeferreds.length - 2].resolve({ stopReason: 'end_turn' });
            }
            return d.promise;
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

    const ensured = await client.ensureSession({ cwd: '/tmp' });

    // No turn active yet -> steer returns false
    assert.equal(
      await client.steer(ensured.sessionId, [{ type: 'text', text: 'noop' }]),
      false,
    );

    const turnPromise = client.prompt(ensured.sessionId, [{ type: 'text', text: 'step 1 and 2' }]);
    // Wait a tick for initial prompt RPC to register
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(promptDeferreds.length, 1);

    // Emit partial progress before steer
    internal.handleSessionUpdate({
      sessionId: ensured.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        name: 'run_command',
        title: 'step 1',
        status: 'in_progress',
      },
    });

    // First steer
    const steered1 = await client.steer(ensured.sessionId, [{ type: 'text', text: 'skip step 2' }]);
    assert.equal(steered1, true);
    assert.equal(promptDeferreds.length, 2);

    // Second steer before first steer finishes
    const steered2 = await client.steer(ensured.sessionId, [
      { type: 'text', text: 'just reply FINAL_STEERED' },
    ]);
    assert.equal(steered2, true);
    assert.equal(promptDeferreds.length, 3);

    // Stream updates belonging to final steered turn
    internal.handleSessionUpdate({
      sessionId: ensured.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
      },
    });
    internal.handleSessionUpdate({
      sessionId: ensured.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'FINAL_STEERED' },
      },
    });

    promptDeferreds[2].resolve({
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    const result = await turnPromise;
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'FINAL_STEERED');
    assert.equal(result.toolEvents.length, 1);
    assert.equal(result.toolEvents[0].status, 'completed');
    assert.equal(result.usage.totalTokens, 120);
    assert.equal(sentPrompts.length, 3);

    // After turn finishes, active collector must be cleaned up
    assert.equal(
      await client.steer(ensured.sessionId, [{ type: 'text', text: 'after done' }]),
      false,
    );
  });
});

describe('FeishuAcpGateway running-turn queue vs steer interactive card flow', () => {
  function setupGateway(tmpDir: string, opts: { failChoiceCard?: boolean } = {}) {
    const sentCards: Array<{ messageId: string; target: FeishuSendTarget; card: Record<string, unknown> }> = [];
    const patchedCards: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const promptCalls: Array<{
      sessionId: string;
      blocks: unknown[];
      deferred: ReturnType<typeof makeDeferred<AcpPromptResult>>;
    }> = [];
    const steerCalls: Array<{ sessionId: string; blocks: unknown[] }> = [];
    const cancelCalls: string[] = [];

    let onMessage!: (ev: FeishuRawMessageReceiveEvent) => Promise<void>;
    let onCardAction!: (ev: FeishuCardActionTriggerEvent) => Promise<FeishuCardCallbackResponse | void>;

    const fakeFeishu = {
      getBotInfo: async () => ({ openId: 'ou_bot', appName: 'TestBot' }),
      startWebSocket: async (
        handler: (ev: FeishuRawMessageReceiveEvent) => Promise<void>,
        callbacks?: {
          onCardAction?: (
            ev: FeishuCardActionTriggerEvent,
          ) => Promise<FeishuCardCallbackResponse | void>;
        },
      ) => {
        onMessage = handler;
        onCardAction = callbacks!.onCardAction!;
      },
      stopWebSocket: () => undefined,
      getMessage: async () => null,
      downloadMessageResource: async () => '',
      createMessageCot: async () => ({ cotId: 'cot_1', messageId: 'om_cot_1' }),
      writeMessageCotEvents: async () => undefined,
      completeMessageCot: async () => undefined,
      sendCard: async (target: FeishuSendTarget, card: Record<string, unknown>) => {
        if (opts.failChoiceCard && extractCallbackButtons(card).length > 0) {
          throw new Error('simulated sendCard failure');
        }
        const messageId = `om_card_${sentCards.length + 1}`;
        sentCards.push({ messageId, target, card });
        return messageId;
      },
      patchCard: async (messageId: string, card: Record<string, unknown>) => {
        patchedCards.push({ messageId, card });
      },
      sendText: async () => 'om_text_1',
    } as unknown as FeishuGatewayClient;

    const fakeAcp = {
      initialize: async () => ({ protocolVersion: 1, agentInfo: { name: 'agy', version: '1.0' } }),
      shutdown: async () => undefined,
      setAsyncTurnHandler: () => undefined,
      takePendingAsyncTurn: () => null,
      ensureSession: async () => ({
        sessionId: 'sess_gw_mode',
        loaded: false,
        currentModelId: 'gemini-4-neon',
        availableModels: [],
        availableThoughtLevels: [],
      }),
      prompt: async (sessionId: string, blocks: unknown[], _handlers?: AcpPromptHandlers) => {
        const deferred = makeDeferred<AcpPromptResult>();
        promptCalls.push({ sessionId, blocks, deferred });
        return deferred.promise;
      },
      steer: async (sessionId: string, blocks: unknown[]) => {
        steerCalls.push({ sessionId, blocks });
        return true;
      },
      cancel: async (sessionId: string) => {
        cancelCalls.push(sessionId);
      },
    } as unknown as AgyAcpClient;

    const gateway = new FeishuAcpGateway(makeConfig(tmpDir), fakeFeishu, fakeAcp);
    return {
      gateway,
      sentCards,
      patchedCards,
      promptCalls,
      steerCalls,
      cancelCalls,
      getOnMessage: () => onMessage,
      getOnCardAction: () => onCardAction,
    };
  }

  it('sends choice card when a task is running and steers the active turn when user clicks 引导当前任务', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gw-steer-'));
    try {
      const env = setupGateway(tmpDir);
      await env.gateway.start();

      // Start turn 1 (remains in flight)
      const turn1Done = env.getOnMessage()(makeGroupEvent('om_1', '分析代码库'));
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(env.promptCalls.length, 1);

      // Turn 2 arrives while turn 1 is running -> must show choice card instead of queuing
      await env.getOnMessage()(makeGroupEvent('om_2', '重点看 src/gateway.ts'));
      assert.equal(env.promptCalls.length, 1);
      assert.equal(env.sentCards.length, 1);

      const choiceCard = env.sentCards[0];
      const buttons = extractCallbackButtons(choiceCard.card);
      const steerBtn = buttons.find((b) => b.value.mode === 'steer');
      assert.ok(steerBtn);

      // User clicks 引导当前任务
      const cbRes = await env.getOnCardAction()({
        action: { tag: 'button', value: steerBtn.value },
        context: { open_message_id: choiceCard.messageId, open_chat_id: 'oc_grp_mode' },
      });
      assert.ok(cbRes);
      assert.equal(cbRes.toast?.type, 'success');
      assert.match(cbRes.toast?.content ?? '', /引导/);
      assert.equal(cbRes.card?.type, 'raw');
      assert.equal(extractCallbackButtons(cbRes.card!.data).length, 0);

      assert.equal(env.steerCalls.length, 1);
      assert.equal(env.steerCalls[0].sessionId, 'sess_gw_mode');
      assert.match(JSON.stringify(env.steerCalls[0].blocks), /src\/gateway\.ts/);

      // Duplicate click is idempotent and does NOT call steer again
      const dupRes = await env.getOnCardAction()({
        action: { tag: 'button', value: steerBtn.value },
      });
      assert.equal(dupRes?.toast?.type, 'info');
      assert.equal(env.steerCalls.length, 1);

      // Finish turn 1 -> no extra queued turn runs because turn 2 was steered
      env.promptCalls[0].deferred.resolve({
        stopReason: 'end_turn',
        text: '已结合你的引导完成分析。',
        thoughtText: '',
        toolEvents: [],
        usage: {},
      });
      await turn1Done;
      assert.equal(env.promptCalls.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('queues the new message behind the running turn when user clicks 加入排队 and discards when clicking 取消', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gw-queue-'));
    try {
      const env = setupGateway(tmpDir);
      await env.gateway.start();

      const turn1Done = env.getOnMessage()(makeGroupEvent('om_1', '任务一'));
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(env.promptCalls.length, 1);

      // Turn 2 & Turn 3 arrive while turn 1 runs
      await env.getOnMessage()(makeGroupEvent('om_2', '任务二（排队）'));
      await env.getOnMessage()(makeGroupEvent('om_3', '任务三（取消）'));
      assert.equal(env.sentCards.length, 2);

      const queueBtn = extractCallbackButtons(env.sentCards[0].card).find(
        (b) => b.value.mode === 'queue',
      )!;
      const cancelBtn = extractCallbackButtons(env.sentCards[1].card).find(
        (b) => b.value.mode === 'cancel',
      )!;

      const queueRes = await env.getOnCardAction()({
        action: { tag: 'button', value: queueBtn.value },
      });
      assert.equal(queueRes?.toast?.type, 'success');
      assert.match(queueRes?.toast?.content ?? '', /排队/);

      const cancelRes = await env.getOnCardAction()({
        action: { tag: 'button', value: cancelBtn.value },
      });
      assert.equal(cancelRes?.toast?.type, 'info');
      assert.match(cancelRes?.toast?.content ?? '', /取消/);

      // Turn 2 has NOT started while turn 1 is still running
      assert.equal(env.promptCalls.length, 1);

      // Finish turn 1 -> Turn 2 starts, Turn 3 never runs
      env.promptCalls[0].deferred.resolve({
        stopReason: 'end_turn',
        text: '任务一完成',
        thoughtText: '',
        toolEvents: [],
        usage: {},
      });
      await turn1Done;
      await new Promise((r) => setTimeout(r, 15));

      assert.equal(env.promptCalls.length, 2);
      assert.match(JSON.stringify(env.promptCalls[1].blocks), /任务二（排队）/);

      env.promptCalls[1].deferred.resolve({
        stopReason: 'end_turn',
        text: '任务二完成',
        thoughtText: '',
        toolEvents: [],
        usage: {},
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(env.promptCalls.length, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('auto-promotes unclicked pending messages and patches choice card when the running task finishes first', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gw-auto-'));
    try {
      const env = setupGateway(tmpDir);
      await env.gateway.start();

      const turn1Done = env.getOnMessage()(makeGroupEvent('om_1', '很快结束的任务'));
      await new Promise((r) => setTimeout(r, 15));

      await env.getOnMessage()(makeGroupEvent('om_2', '下一件事'));
      assert.equal(env.sentCards.length, 1);
      const choiceCard = env.sentCards[0];
      const steerBtn = extractCallbackButtons(choiceCard.card).find(
        (b) => b.value.mode === 'steer',
      )!;

      // Turn 1 finishes BEFORE user clicks any button
      env.promptCalls[0].deferred.resolve({
        stopReason: 'end_turn',
        text: '第一个任务完成',
        thoughtText: '',
        toolEvents: [],
        usage: {},
      });
      await turn1Done;
      await new Promise((r) => setTimeout(r, 15));

      // Choice card should be patched to auto_queued and Turn 2 should have started automatically
      assert.equal(env.patchedCards.length, 1);
      assert.equal(env.patchedCards[0].messageId, choiceCard.messageId);
      assert.match(JSON.stringify(env.patchedCards[0].card), /自动开始执行/);
      assert.equal(env.promptCalls.length, 2);
      assert.match(JSON.stringify(env.promptCalls[1].blocks), /下一件事/);

      // Late click on the already-resolved button must NOT re-execute or steer
      const lateRes = await env.getOnCardAction()({
        action: { tag: 'button', value: steerBtn.value },
      });
      assert.equal(lateRes?.toast?.type, 'info');
      assert.equal(env.steerCalls.length, 0);

      env.promptCalls[1].deferred.resolve({
        stopReason: 'end_turn',
        text: '第二个任务完成',
        thoughtText: '',
        toolEvents: [],
        usage: {},
      });
      await new Promise((r) => setTimeout(r, 15));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to default queueing if sending the choice card fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gw-fallback-'));
    try {
      const env = setupGateway(tmpDir, { failChoiceCard: true });
      await env.gateway.start();

      const turn1Done = env.getOnMessage()(makeGroupEvent('om_1', '任务一'));
      await new Promise((r) => setTimeout(r, 15));

      const turn2Done = env.getOnMessage()(makeGroupEvent('om_2', '降级排队消息'));
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(env.promptCalls.length, 1);

      env.promptCalls[0].deferred.resolve({
        stopReason: 'end_turn',
        text: '完成一',
        thoughtText: '',
        toolEvents: [],
        usage: {},
      });
      await turn1Done;
      await new Promise((r) => setTimeout(r, 15));

      assert.equal(env.promptCalls.length, 2);
      assert.match(JSON.stringify(env.promptCalls[1].blocks), /降级排队消息/);

      env.promptCalls[1].deferred.resolve({
        stopReason: 'end_turn',
        text: '完成二',
        thoughtText: '',
        toolEvents: [],
        usage: {},
      });
      await turn2Done;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
