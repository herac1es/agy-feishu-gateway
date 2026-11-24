import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AgyAcpClient, EnsureSessionParams } from '../src/acp/client.js';
import type { GatewayConfig } from '../src/config.js';
import type { FeishuGatewayClient, FeishuRawMessageReceiveEvent } from '../src/feishu/client.js';
import { FeishuAcpGateway } from '../src/gateway.js';
import { SessionStore } from '../src/store.js';

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
      chat_id: 'oc_grp_orch',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

describe('FeishuAcpGateway /model handling for models without thought_level', () => {
  it('clears persisted thoughtLevel when switching to Orchestrator and allows switching back', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feishu-model-switch-'));
    try {
      const storeSeed = new SessionStore(tmpDir);
      storeSeed.set({
        conversationKey: 'group:oc_grp_orch',
        sessionId: 'sess_orch',
        cwd: tmpDir,
        modelId: 'gemini-4-neon',
        thoughtLevel: 'high',
        updatedAt: new Date().toISOString(),
      });

      const replies: string[] = [];
      let receivedHandler!: (ev: FeishuRawMessageReceiveEvent) => Promise<void>;

      const fakeFeishu = {
        getBotInfo: async () => ({ openId: 'ou_bot', appName: 'TestBot' }),
        startWebSocket: async (handler: (ev: FeishuRawMessageReceiveEvent) => Promise<void>) => {
          receivedHandler = handler;
        },
        stopWebSocket: () => undefined,
        getMessage: async () => null,
        downloadMessageResource: async () => '',
        sendText: async (_target: unknown, text: string) => {
          replies.push(text);
          return `om_reply_${replies.length}`;
        },
      } as unknown as FeishuGatewayClient;

      let activeModel = 'gemini-4-neon';
      let activeThought: string | undefined = 'high';
      const ensureCalls: EnsureSessionParams[] = [];

      const availableModels = [
        { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
      ];
      const neonThoughtLevels = [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ];

      const fakeAcp = {
        initialize: async () => ({ protocolVersion: 1, agentInfo: { name: 'agy', version: '1.0' } }),
        shutdown: async () => undefined,
        ensureSession: async (params: EnsureSessionParams) => {
          ensureCalls.push(params);
          if (params.modelId === 'gemini-pro-orchestrator-neon' && params.thoughtLevel) {
            throw new Error('Thinking level "high" is not offered for model "Orchestrator (Neon)"');
          }
          const isOrch = activeModel === 'gemini-pro-orchestrator-neon';
          return {
            sessionId: params.sessionId ?? 'sess_orch',
            loaded: true,
            currentModelId: activeModel,
            currentThoughtLevel: isOrch ? undefined : activeThought,
            availableModels,
            availableThoughtLevels: isOrch ? [] : neonThoughtLevels,
          };
        },
        setSessionConfig: async (
          _sessionId: string,
          params: { modelId?: string; thoughtLevel?: string; knownThoughtLevels?: unknown[] },
        ) => {
          if (params.modelId) {
            activeModel = params.modelId;
            activeThought = activeModel === 'gemini-pro-orchestrator-neon' ? undefined : 'high';
          }
          if (params.thoughtLevel) {
            if (activeModel === 'gemini-pro-orchestrator-neon') {
              throw new Error(`当前模型 ${activeModel} 不支持设置思考强度。`);
            }
            activeThought = params.thoughtLevel;
          }
          const isOrch = activeModel === 'gemini-pro-orchestrator-neon';
          return {
            currentModelId: activeModel,
            currentThoughtLevel: isOrch ? undefined : activeThought,
            availableModels,
            availableThoughtLevels: isOrch ? [] : neonThoughtLevels,
          };
        },
      } as unknown as AgyAcpClient;

      const gateway = new FeishuAcpGateway(makeConfig(tmpDir), fakeFeishu, fakeAcp);
      await gateway.start();

      // 1. Switch from gemini-4-neon (high) to Orchestrator (no thought_level)
      await receivedHandler(makeGroupEvent('om_1', '/model gemini-pro-orchestrator-neon'));
      assert.equal(replies.length, 1);
      assert.match(replies[0], /gemini-pro-orchestrator-neon/);
      assert.match(replies[0], /已自动清除原有设置（high）/);

      const afterOrch = new SessionStore(tmpDir).get('group:oc_grp_orch');
      assert.equal(afterOrch?.modelId, 'gemini-pro-orchestrator-neon');
      assert.equal(afterOrch?.thoughtLevel, undefined);

      // 2. Explicitly setting thought_level while on Orchestrator returns a clear error
      await receivedHandler(makeGroupEvent('om_2', '/model high'));
      assert.equal(replies.length, 2);
      assert.match(replies[1], /切换模型\/思考强度失败.*不支持设置思考强度/);

      // 3. Even if a dirty persisted record (orchestrator + high) exists, `/model gemini-4-neon` can still recover
      const dirtyStore = new SessionStore(tmpDir);
      dirtyStore.set({
        conversationKey: 'group:oc_grp_orch',
        sessionId: 'sess_orch',
        cwd: tmpDir,
        modelId: 'gemini-pro-orchestrator-neon',
        thoughtLevel: 'high',
        updatedAt: new Date().toISOString(),
      });
      const recoveredGateway = new FeishuAcpGateway(makeConfig(tmpDir), fakeFeishu, fakeAcp);
      await recoveredGateway.start();

      await receivedHandler(makeGroupEvent('om_3', '/model gemini-4-neon medium'));
      assert.equal(replies.length, 3);
      assert.match(replies[2], /gemini-4-neon/);
      assert.match(replies[2], /medium/);
      // Verify /model <modelId> bypassed applying the stale modelId/thoughtLevel during ensureSession
      assert.equal(ensureCalls.at(-1)?.modelId, undefined);
      assert.equal(ensureCalls.at(-1)?.thoughtLevel, undefined);

      const afterRecover = new SessionStore(tmpDir).get('group:oc_grp_orch');
      assert.equal(afterRecover?.modelId, 'gemini-4-neon');
      assert.equal(afterRecover?.thoughtLevel, 'medium');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
