import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildSystemdUnit,
  buildWrapperScript,
  getCurrentReleaseId,
  listInstalledReleases,
  pruneOldReleases,
  releaseLocal,
  resolveReleaseLayout,
  rollbackLocal,
} from '../scripts/local-release.mjs';
import { loadConfig } from '../src/config.js';

const DEV_ROOT = path.resolve(import.meta.dirname, '..');

describe('runtime config overrides & local release workflow', () => {
  it('loads explicit AGY_GATEWAY_* paths and release-meta.json metadata', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cfg-override-'));
    const envKeys = [
      'AGY_GATEWAY_ENV_FILE',
      'AGY_GATEWAY_DATA_DIR',
      'AGY_GATEWAY_LOCK_DIR',
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'DEFAULT_CWD',
      'DATA_DIR',
    ] as const;
    const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

    try {
      const workCwd = path.join(tmpRoot, 'cwd');
      const dataDir = path.join(tmpRoot, 'runtime-data');
      const lockDir = path.join(tmpRoot, 'runtime-locks');
      const envFile = path.join(tmpRoot, 'runtime.env');
      fs.mkdirSync(workCwd, { recursive: true });
      fs.writeFileSync(
        envFile,
        [
          'FEISHU_APP_ID=cli_override_app',
          'FEISHU_APP_SECRET=sec_override',
          `DEFAULT_CWD=${workCwd}`,
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmpRoot, 'package.json'),
        JSON.stringify({ name: 'agy-feishu-gateway', version: '0.9.9' }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmpRoot, 'release-meta.json'),
        JSON.stringify({ releaseId: '0.9.9-20261121-120000' }),
        'utf8',
      );

      for (const k of envKeys) delete process.env[k];
      process.env.AGY_GATEWAY_ENV_FILE = envFile;
      process.env.AGY_GATEWAY_DATA_DIR = dataDir;
      process.env.AGY_GATEWAY_LOCK_DIR = lockDir;

      const cfg = loadConfig(tmpRoot);
      assert.equal(cfg.feishuAppId, 'cli_override_app');
      assert.equal(cfg.envFile, envFile);
      assert.equal(cfg.dataDir, dataDir);
      assert.equal(cfg.lockDir, lockDir);
      assert.equal(cfg.version, '0.9.9');
      assert.equal(cfg.releaseId, '0.9.9-20261121-120000');

      // When DEFAULT_CWD is blank, defaultCwd resolves to sibling `workspace` beside `dataDir` and creates it
      const envBlankCwd = path.join(tmpRoot, 'runtime-blank-cwd.env');
      const siblingDataDir = path.join(tmpRoot, 'home-a', 'data');
      fs.writeFileSync(
        envBlankCwd,
        ['FEISHU_APP_ID=cli_override_app', 'FEISHU_APP_SECRET=sec_override', 'DEFAULT_CWD='].join('\n'),
        'utf8',
      );
      delete process.env.DEFAULT_CWD;
      process.env.AGY_GATEWAY_ENV_FILE = envBlankCwd;
      process.env.AGY_GATEWAY_DATA_DIR = siblingDataDir;
      const cfgAutoWorkspace = loadConfig(tmpRoot);
      const expectedWorkspace = path.join(tmpRoot, 'home-a', 'workspace');
      assert.equal(cfgAutoWorkspace.defaultCwd, expectedWorkspace);
      assert.ok(fs.existsSync(expectedWorkspace) && fs.statSync(expectedWorkspace).isDirectory());
    } finally {
      for (const k of envKeys) {
        if (saved[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[k];
        }
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('generates wrapper script and systemd unit preserving runtime isolation, PATH, and proxies', () => {
    const layout = resolveReleaseLayout('/tmp/agy-gw-home');
    const wrapper = buildWrapperScript(layout, '/usr/bin/node');
    assert.ok(wrapper.includes('export AGY_GATEWAY_ENV_FILE="/tmp/agy-gw-home/.env"'));
    assert.ok(wrapper.includes('exec "/usr/bin/node" "/tmp/agy-gw-home/current/dist/cli.js" "$@"'));

    const unit = buildSystemdUnit(layout, {
      nodeBin: '/usr/bin/node',
      env: {
        PATH: '/usr/bin:/bin',
        https_proxy: 'http://proxy.internal:8118',
        no_proxy: '127.0.0.1,localhost',
      },
    });
    assert.ok(unit.includes('ExecStart=/usr/bin/node /tmp/agy-gw-home/current/dist/cli.js start'));
    assert.ok(unit.includes('Environment="AGY_GATEWAY_DATA_DIR=/tmp/agy-gw-home/data"'));
    assert.ok(unit.includes('Environment="AGY_GATEWAY_LOCK_DIR=/tmp/agy-gw-home/locks"'));
    assert.ok(unit.includes('.local/bin'));
    assert.ok(unit.includes('Environment="https_proxy=http://proxy.internal:8118"'));
  });

  it('publishes immutable isolated releases, preserves runtime .env, rolls back, and prunes old snapshots', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-release-e2e-'));
    try {
      const r1 = await releaseLocal({
        devRoot: DEV_ROOT,
        gatewayHome: tempHome,
        skipTests: true,
        skipCheck: true,
        noSystemd: true,
        noRestart: true,
        keep: 2,
      });
      assert.equal(getCurrentReleaseId(r1.layout), r1.releaseId);
      assert.ok(fs.existsSync(path.join(r1.releaseDir, 'dist', 'cli.js')));
      assert.ok(fs.existsSync(path.join(r1.releaseDir, 'node_modules', '@larksuiteoapi', 'node-sdk')));
      assert.ok(fs.existsSync(r1.layout.envFile));
      assert.ok(fs.existsSync(r1.layout.workspaceDir) && fs.statSync(r1.layout.workspaceDir).isDirectory());

      // Simulate user editing runtime .env independently from dev repo
      fs.appendFileSync(r1.layout.envFile, '\n# RUNTIME_ONLY_MARKER=preserved\n', 'utf8');

      await new Promise((r) => setTimeout(r, 1100));
      const r2 = await releaseLocal({
        devRoot: DEV_ROOT,
        gatewayHome: tempHome,
        skipTests: true,
        skipCheck: true,
        noSystemd: true,
        noRestart: true,
        keep: 5,
      });
      assert.notEqual(r2.releaseId, r1.releaseId);
      assert.equal(getCurrentReleaseId(r2.layout), r2.releaseId);
      assert.ok(fs.readFileSync(r2.layout.envFile, 'utf8').includes('RUNTIME_ONLY_MARKER=preserved'));

      await new Promise((r) => setTimeout(r, 1100));
      const r3 = await releaseLocal({
        devRoot: DEV_ROOT,
        gatewayHome: tempHome,
        skipTests: true,
        skipCheck: true,
        noSystemd: true,
        noRestart: true,
        keep: 2,
      });
      assert.equal(getCurrentReleaseId(r3.layout), r3.releaseId);

      const remainingAfterPrune = listInstalledReleases(r3.layout);
      assert.equal(remainingAfterPrune.length, 2);
      assert.equal(remainingAfterPrune[0].releaseId, r3.releaseId);

      // Roll back to previous remaining release (r2) without deleting current
      const rolled = await rollbackLocal(undefined, {
        gatewayHome: tempHome,
        skipCheck: true,
        noSystemd: true,
        noRestart: true,
      });
      assert.equal(rolled.releaseId, r2.releaseId);
      assert.equal(getCurrentReleaseId(r3.layout), r2.releaseId);

      const prunedNone = pruneOldReleases(r3.layout, 2);
      assert.equal(prunedNone.length, 0);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
