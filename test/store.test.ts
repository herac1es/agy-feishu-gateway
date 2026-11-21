import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageDeduper, SessionStore } from '../src/store.js';

describe('SessionStore & MessageDeduper', () => {
  it('persists session records atomically and survives reload', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feishu-store-'));
    try {
      const store1 = new SessionStore(tmpDir);
      store1.set({
        conversationKey: 'p2p:oc_123',
        sessionId: 'sess-abc',
        cwd: '/home/malishen/github.com/coolbot',
        modelId: 'gemini-4-neon',
        updatedAt: '2026-11-21T00:00:00.000Z',
      });
      store1.set({
        conversationKey: 'group:oc_456',
        cwd: '/tmp/other',
        updatedAt: '2026-11-21T00:01:00.000Z',
      });

      const store2 = new SessionStore(tmpDir);
      assert.equal(store2.list().length, 2);
      assert.equal(store2.get('p2p:oc_123')?.sessionId, 'sess-abc');
      assert.equal(store2.get('group:oc_456')?.sessionId, undefined);
      assert.equal(store2.get('group:oc_456')?.cwd, '/tmp/other');

      assert.equal(store2.delete('p2p:oc_123'), true);
      const store3 = new SessionStore(tmpDir);
      assert.equal(store3.get('p2p:oc_123'), undefined);
      assert.equal(store3.list().length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('evicts oldest keys when exceeding MessageDeduper capacity', () => {
    const deduper = new MessageDeduper(10);
    for (let i = 0; i < 12; i += 1) {
      assert.equal(deduper.markIfNew(`msg-${i}`), true);
    }
    assert.equal(deduper.markIfNew('msg-11'), false);
    assert.equal(deduper.markIfNew('msg-0'), true);
  });
});
