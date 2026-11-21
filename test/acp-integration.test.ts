import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgyAcpClient } from '../src/acp/client.js';

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

      // Switch back to flash low for fast PONG prompt check
      const restored = await client.setSessionConfig(session.sessionId, {
        modelId: 'gemini-4-neon',
        thoughtLevel: 'low',
      });
      assert.equal(restored.currentModelId, 'gemini-4-neon');
      assert.equal(restored.currentThoughtLevel, 'low');

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

      await client.closeSession(session.sessionId);
    } finally {
      await client.shutdown();
    }
  });
});
