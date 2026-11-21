import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  AppInstanceLock,
  AppLockConflictError,
  isPidAlive,
  readLockFile,
  resolveLockFilePath,
} from '../src/lock.js';

function pickDeadPid(): number {
  for (let candidate = 999_999; candidate > 900_000; candidate -= 1) {
    if (!isPidAlive(candidate)) {
      return candidate;
    }
  }
  return 999_999;
}

describe('AppInstanceLock', () => {
  it('acquires, blocks duplicate same-AppID starts, allows different AppIDs, and releases cleanly', () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lock-test-'));
    try {
      const lock1 = AppInstanceLock.acquire({
        lockDir,
        appId: 'cli_test_app_1',
        releaseId: '0.1.0-rel1',
        version: '0.1.0',
        rootDir: '/tmp/runtime-1',
      });
      assert.ok(fs.existsSync(lock1.lockPath));
      assert.equal(readLockFile(lock1.lockPath)?.pid, process.pid);

      assert.throws(
        () =>
          AppInstanceLock.acquire({
            lockDir,
            appId: 'cli_test_app_1',
            releaseId: 'dev',
            version: '0.1.0',
            rootDir: '/tmp/dev',
          }),
        (err) => {
          assert.ok(err instanceof AppLockConflictError);
          assert.equal(err.existing?.pid, process.pid);
          assert.ok(err.message.includes('cli_test_app_1'));
          assert.ok(err.message.includes('pnpm release'));
          return true;
        },
      );

      // A separate test Feishu AppID can run concurrently without conflict
      const lockOther = AppInstanceLock.acquire({
        lockDir,
        appId: 'cli_test_app_2',
        releaseId: 'dev',
        version: '0.1.0',
        rootDir: '/tmp/dev',
      });
      assert.ok(fs.existsSync(lockOther.lockPath));

      lock1.release();
      lockOther.release();
      assert.equal(fs.existsSync(lock1.lockPath), false);
      assert.equal(fs.existsSync(lockOther.lockPath), false);
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });

  it('reclaims stale dead-PID lock files and ignores release when overwritten by another PID', () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lock-stale-'));
    try {
      const stalePath = resolveLockFilePath(lockDir, 'cli_stale_app');
      const deadPid = pickDeadPid();
      fs.writeFileSync(
        stalePath,
        JSON.stringify({
          pid: deadPid,
          appId: 'cli_stale_app',
          releaseId: '0.1.0-old',
          version: '0.1.0',
          rootDir: '/tmp/old',
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
        'utf8',
      );

      const lock = AppInstanceLock.acquire({
        lockDir,
        appId: 'cli_stale_app',
        releaseId: 'dev',
        version: '0.1.0',
        rootDir: '/tmp/new',
      });
      assert.equal(readLockFile(lock.lockPath)?.pid, process.pid);

      // Simulate another owner taking over the file: release() must not delete foreign lock
      fs.writeFileSync(
        lock.lockPath,
        JSON.stringify({
          pid: process.pid + 1,
          appId: 'cli_stale_app',
          releaseId: 'other',
          version: '0.1.0',
          rootDir: '/tmp/other',
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
        'utf8',
      );
      lock.release();
      assert.equal(fs.existsSync(lock.lockPath), true);
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});
