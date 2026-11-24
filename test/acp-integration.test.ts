import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgyAcpClient, type AcpAsyncTurnResult } from '../src/acp/client.js';

describe('AgyAcpClient integration', () => {
  it('connects to local agy acp, creates a session, completes a prompt, and shuts down cleanly', async () => {
    const client = new AgyAcpClient({
      agyBin: process.env.AGY_BIN?.trim() || 'agy',
      defaultCwd: '/home/malishen/github.com/coolbot',
    });

    try {
      const init = await client.initialize();
      assert.ok(init.protocolVersion >= 1);
      assert.ok(init.agentInfo?.name);

      const session = await client.ensureSession({
        cwd: '/home/malishen/github.com/coolbot',
      });
      assert.ok(session.sessionId);
      assert.ok(session.availableModels.length > 0);
      assert.ok(session.availableThoughtLevels.length > 0);

      // Verify switching thought_level alone, and switching model + thought_level together
      const updatedThought = await client.setSessionConfig(session.sessionId, {
        thoughtLevel: 'medium',
        knownThoughtLevels: session.availableThoughtLevels,
      });
      assert.equal(updatedThought.currentThoughtLevel, 'medium');

      const updatedBoth = await client.setSessionConfig(session.sessionId, {
        modelId: 'claude-sonnet-5-5',
        thoughtLevel: 'high',
      });
      assert.equal(updatedBoth.currentModelId, 'claude-sonnet-5-5');
      assert.equal(updatedBoth.currentThoughtLevel, 'high');

      // Switch to an Orchestrator model that does not expose thought_level
      const orchestratorState = await client.setSessionConfig(session.sessionId, {
        modelId: 'gemini-pro-orchestrator-neon',
      });
      assert.equal(orchestratorState.currentModelId, 'gemini-pro-orchestrator-neon');
      assert.equal(orchestratorState.currentThoughtLevel, undefined);
      assert.deepEqual(orchestratorState.availableThoughtLevels, []);

      // Loading an existing Orchestrator session with a stale thoughtLevel must not fail
      const reloadedOrch = await client.ensureSession({
        cwd: '/home/malishen/github.com/coolbot',
        sessionId: session.sessionId,
        modelId: 'gemini-pro-orchestrator-neon',
        thoughtLevel: 'high',
      });
      assert.equal(reloadedOrch.currentModelId, 'gemini-pro-orchestrator-neon');
      assert.equal(reloadedOrch.currentThoughtLevel, undefined);
      assert.deepEqual(reloadedOrch.availableThoughtLevels, []);

      // Explicitly requesting a thought level on a model without thought_level must fail cleanly
      await assert.rejects(
        () =>
          client.setSessionConfig(session.sessionId, {
            thoughtLevel: 'high',
            knownThoughtLevels: reloadedOrch.availableThoughtLevels,
          }),
        /不支持设置思考强度/,
      );

      // Switch back to flash/neon low for fast PONG prompt check
      const restored = await client.setSessionConfig(session.sessionId, {
        modelId: 'gemini-4-neon',
        thoughtLevel: 'low',
      });
      assert.equal(restored.currentModelId, 'gemini-4-neon');
      assert.equal(restored.currentThoughtLevel, 'low');
      assert.ok(restored.availableThoughtLevels.length > 0);

      let streamed = '';
      const turn = await client.prompt(
        session.sessionId,
        [{ type: 'text', text: 'Reply with ONLY the word PONG. Do not call any tools.' }],
        {
          onTextChunk: (acc) => {
            streamed = acc;
          },
        },
      );

      assert.equal(turn.stopReason, 'end_turn');
      assert.ok(turn.text.includes('PONG'), `Expected PONG in "${turn.text}"`);
      assert.equal(streamed, turn.text);

      // Reconnecting from a brand-new ACP client via session/resume must not leak historical replies into the next prompt
      const secondClient = new AgyAcpClient({
        agyBin: process.env.AGY_BIN?.trim() || 'agy',
        defaultCwd: '/home/malishen/github.com/coolbot',
      });
      try {
        await secondClient.initialize();
        const resumed = await secondClient.ensureSession({
          cwd: '/home/malishen/github.com/coolbot',
          sessionId: session.sessionId,
          modelId: 'gemini-4-neon',
          thoughtLevel: 'low',
        });
        assert.equal(resumed.sessionId, session.sessionId);
        assert.equal(resumed.loaded, true);

        const turn2 = await secondClient.prompt(resumed.sessionId, [
          { type: 'text', text: 'Reply with ONLY the word CLEAN_TURN_2. Do not call any tools.' },
        ]);
        assert.equal(turn2.stopReason, 'end_turn');
        assert.ok(turn2.text.includes('CLEAN_TURN_2'), `Expected CLEAN_TURN_2 in "${turn2.text}"`);
        assert.ok(
          !turn2.text.includes('PONG'),
          `Historical PONG leaked into turn2 reply: "${turn2.text}"`,
        );
      } finally {
        await secondClient.shutdown();
      }

      await client.closeSession(session.sessionId);
    } finally {
      await client.shutdown();
    }
  });

  it('delivers unsolicited async follow-up turns after a background task completes post-prompt', async () => {
    const asyncResults: AcpAsyncTurnResult[] = [];
    let resolveAsync!: (res: AcpAsyncTurnResult) => void;
    const asyncReceived = new Promise<AcpAsyncTurnResult>((resolve) => {
      resolveAsync = resolve;
    });

    const client = new AgyAcpClient({
      agyBin: process.env.AGY_BIN?.trim() || 'agy',
      defaultCwd: '/home/malishen/.agy-feishu-gateway-workspace',
      asyncSettleAfterUsageMs: 500,
      asyncSettleFallbackMs: 2500,
      onAsyncTurn: (res) => {
        asyncResults.push(res);
        resolveAsync(res);
      },
    });

    try {
      await client.initialize();
      const session = await client.ensureSession({
        cwd: '/home/malishen/.agy-feishu-gateway-workspace',
        modelId: 'gemini-4-neon',
        thoughtLevel: 'low',
      });

      const prelim = await client.prompt(session.sessionId, [
        {
          type: 'text',
          text: 'Call run_command with CommandLine="sleep 10 && echo BG_OK_42" and WaitMsBeforeAsync=500 so it runs in the background. Immediately after it backgrounds, reply ONLY with "PRELIM_SENT" and end your turn without waiting. Later when the background task finishes and wakes you up, reply ONLY with "ASYNC_FINAL_42".',
        },
      ]);

      assert.equal(prelim.stopReason, 'end_turn');
      assert.match(prelim.text, /PRELIM_SENT/);

      // If the background task completed before the interim reply finished, accept it inline;
      // otherwise wait for the unsolicited async follow-up callback.
      if (!prelim.text.includes('ASYNC_FINAL_42')) {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for async follow-up turn')), 35_000),
        );
        const asyncTurn = await Promise.race([asyncReceived, timeout]);
        assert.equal(asyncTurn.sessionId, session.sessionId);
        assert.match(asyncTurn.text, /ASYNC_FINAL_42/);
        assert.equal(asyncResults.length >= 1, true);
      }

      await client.closeSession(session.sessionId);
    } finally {
      await client.shutdown();
    }
  });

  it('steers an in-flight prompt turn mid-execution via AgyAcpClient.steer()', async () => {
    const client = new AgyAcpClient({
      agyBin: process.env.AGY_BIN?.trim() || 'agy',
      defaultCwd: '/home/malishen/.agy-feishu-gateway-workspace',
    });

    try {
      await client.initialize();
      const session = await client.ensureSession({
        cwd: '/home/malishen/.agy-feishu-gateway-workspace',
        modelId: 'gemini-4-neon',
        thoughtLevel: 'low',
      });

      const turnPromise = client.prompt(session.sessionId, [
        {
          type: 'text',
          text: 'First run bash command `sleep 4 && echo STEP1_OK`. After that finishes, run a second bash command `echo STEP2_BAD`. Finally report both outputs.',
        },
      ]);

      // Wait briefly so step 1 is in flight, then steer mid-turn.
      await new Promise((r) => setTimeout(r, 2500));
      const steered = await client.steer(session.sessionId, [
        {
          type: 'text',
          text: 'Change of plan: do NOT run STEP2_BAD. Simply reply with the exact token STEER_HANDOFF_OK.',
        },
      ]);
      assert.equal(steered, true);

      const result = await turnPromise;
      assert.equal(result.stopReason, 'end_turn');
      assert.match(result.text, /STEER_HANDOFF_OK/);
      assert.doesNotMatch(result.text, /STEP2_BAD/);

      await client.closeSession(session.sessionId);
    } finally {
      await client.shutdown();
    }
  });
});
