#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'agy-feishu-gateway.service';
const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
];

function expandUserPath(rawPath, baseDir) {
  const trimmed = rawPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(baseDir ?? os.homedir(), trimmed);
}

export function resolvePackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function resolveReleaseLayout(homeOverride) {
  const rawHome =
    homeOverride?.trim() ||
    process.env.AGY_GATEWAY_HOME?.trim() ||
    path.join(os.homedir(), '.local', 'share', 'agy-feishu-gateway');
  const homeDir = expandUserPath(rawHome, os.homedir());
  return {
    homeDir,
    releasesDir: path.join(homeDir, 'releases'),
    currentLink: path.join(homeDir, 'current'),
    envFile: path.join(homeDir, '.env'),
    dataDir: path.join(homeDir, 'data'),
    workspaceDir: path.join(homeDir, 'workspace'),
    lockDir: path.join(homeDir, 'locks'),
    binPath:
      process.env.AGY_GATEWAY_BIN_PATH?.trim() ||
      path.join(os.homedir(), '.local', 'bin', 'agy-feishu-gateway'),
    systemdUnitPath:
      process.env.AGY_GATEWAY_UNIT_PATH?.trim() ||
      path.join(os.homedir(), '.config', 'systemd', 'user', SERVICE_NAME),
  };
}

export function formatReleaseId(version, now = new Date(), gitShortSha) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  const cleanSha = gitShortSha?.trim().replace(/[^a-zA-Z0-9]/g, '');
  return cleanSha ? `${version}-${stamp}-${cleanSha}` : `${version}-${stamp}`;
}

export function buildServicePath(currentPath = process.env.PATH || '', nodeBin = process.execPath) {
  const required = [
    path.join(os.homedir(), '.local', 'bin'),
    path.dirname(nodeBin),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const merged = [];
  const seen = new Set();
  for (const entry of [...required, ...currentPath.split(':')]) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged.join(':');
}

function escapeSystemdEnvValue(key, value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${key}=${escaped}"`;
}

export function buildWrapperScript(layout, nodeBin = process.execPath) {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    `export AGY_GATEWAY_HOME=${JSON.stringify(layout.homeDir)}`,
    `export AGY_GATEWAY_ENV_FILE=${JSON.stringify(layout.envFile)}`,
    `export AGY_GATEWAY_DATA_DIR=${JSON.stringify(layout.dataDir)}`,
    `export AGY_GATEWAY_LOCK_DIR=${JSON.stringify(layout.lockDir)}`,
    `exec ${JSON.stringify(nodeBin)} ${JSON.stringify(path.join(layout.currentLink, 'dist', 'cli.js'))} "$@"`,
    '',
  ].join('\n');
}

export function buildSystemdUnit(layout, options = {}) {
  const nodeBin = options.nodeBin ?? process.execPath;
  const env = options.env ?? process.env;
  const servicePath = buildServicePath(env.PATH || '', nodeBin);

  const envLines = [
    `Environment=${escapeSystemdEnvValue('PATH', servicePath)}`,
    `Environment=${escapeSystemdEnvValue('AGY_GATEWAY_HOME', layout.homeDir)}`,
    `Environment=${escapeSystemdEnvValue('AGY_GATEWAY_ENV_FILE', layout.envFile)}`,
    `Environment=${escapeSystemdEnvValue('AGY_GATEWAY_DATA_DIR', layout.dataDir)}`,
    `Environment=${escapeSystemdEnvValue('AGY_GATEWAY_LOCK_DIR', layout.lockDir)}`,
  ];

  for (const key of PROXY_ENV_KEYS) {
    const val = env[key];
    if (typeof val === 'string' && val.trim()) {
      envLines.push(`Environment=${escapeSystemdEnvValue(key, val.trim())}`);
    }
  }

  return [
    '[Unit]',
    'Description=Antigravity ACP Feishu Bot Gateway',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${layout.homeDir}`,
    ...envLines,
    `ExecStart=${nodeBin} ${path.join(layout.currentLink, 'dist', 'cli.js')} start`,
    'Restart=on-failure',
    'RestartSec=3',
    'TimeoutStopSec=15',
    'KillSignal=SIGTERM',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function readJsonOptional(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectGitShortSha(devRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: devRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function getCurrentReleaseId(layout) {
  if (!fs.existsSync(layout.currentLink)) {
    return null;
  }
  try {
    const real = fs.realpathSync(layout.currentLink);
    return path.basename(real);
  } catch {
    return null;
  }
}

export function listInstalledReleases(layout) {
  if (!fs.existsSync(layout.releasesDir)) {
    return [];
  }
  const activeId = getCurrentReleaseId(layout);
  const entries = fs
    .readdirSync(layout.releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(layout.releasesDir, entry.name);
      const stat = fs.statSync(dir);
      const meta = readJsonOptional(path.join(dir, 'release-meta.json'));
      return {
        releaseId: entry.name,
        dir,
        version: typeof meta?.version === 'string' ? meta.version : 'unknown',
        createdAt:
          typeof meta?.createdAt === 'string' ? meta.createdAt : stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        isCurrent: entry.name === activeId,
      };
    });

  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt > b.createdAt ? -1 : 1;
    }
    return b.mtimeMs - a.mtimeMs;
  });

  return entries;
}

export function pruneOldReleases(layout, keepCount = 5) {
  const keep = Math.max(1, keepCount);
  const releases = listInstalledReleases(layout);
  const removed = [];
  for (let i = keep; i < releases.length; i += 1) {
    const rel = releases[i];
    if (rel.isCurrent) {
      continue;
    }
    fs.rmSync(rel.dir, { recursive: true, force: true });
    removed.push(rel.releaseId);
  }
  return removed;
}

export function swapCurrentSymlink(layout, releaseDir) {
  fs.mkdirSync(layout.homeDir, { recursive: true });
  const tmpLink = path.join(layout.homeDir, `.current.next.${process.pid}.${Date.now()}`);
  try {
    fs.symlinkSync(releaseDir, tmpLink);
    execFileSync('mv', ['-Tf', tmpLink, layout.currentLink], { stdio: 'inherit' });
  } catch (err) {
    try {
      if (fs.lstatSync(tmpLink)) fs.unlinkSync(tmpLink);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

function bootstrapRuntimeHome(devRoot, layout) {
  fs.mkdirSync(layout.releasesDir, { recursive: true });
  fs.mkdirSync(layout.dataDir, { recursive: true });
  fs.mkdirSync(layout.workspaceDir, { recursive: true });
  fs.mkdirSync(layout.lockDir, { recursive: true });

  if (!fs.existsSync(layout.envFile)) {
    const devEnv = path.join(devRoot, '.env');
    if (!fs.existsSync(devEnv)) {
      throw new Error(`首次发布需要配置文件：未找到 ${layout.envFile} 或 ${devEnv}`);
    }
    fs.copyFileSync(devEnv, layout.envFile);
    fs.chmodSync(layout.envFile, 0o600);
    console.log(`[release] 首次初始化线上配置: ${layout.envFile} (mode 600)`);
  }

  // Migrate initial sessions.json once if runtime data dir has none yet
  const targetSessions = path.join(layout.dataDir, 'sessions.json');
  const devSessions = path.join(devRoot, '.data', 'sessions.json');
  if (!fs.existsSync(targetSessions) && fs.existsSync(devSessions)) {
    fs.copyFileSync(devSessions, targetSessions);
    console.log(`[release] 已迁移初始会话记录到 ${targetSessions}`);
  }
}

function installCliWrapper(layout, nodeBin = process.execPath) {
  fs.mkdirSync(path.dirname(layout.binPath), { recursive: true });
  const tmpBin = `${layout.binPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpBin, buildWrapperScript(layout, nodeBin), { mode: 0o755 });
  fs.chmodSync(tmpBin, 0o755);
  fs.renameSync(tmpBin, layout.binPath);
}

function runReleaseCheck(releaseDir, layout, nodeBin = process.execPath) {
  execFileSync(nodeBin, [path.join(releaseDir, 'dist', 'cli.js'), 'check'], {
    cwd: releaseDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      AGY_GATEWAY_HOME: layout.homeDir,
      AGY_GATEWAY_ENV_FILE: layout.envFile,
      AGY_GATEWAY_DATA_DIR: layout.dataDir,
      AGY_GATEWAY_LOCK_DIR: layout.lockDir,
    },
  });
}

function ensureSystemdUnitInstalled(layout, nodeBin = process.execPath) {
  fs.mkdirSync(path.dirname(layout.systemdUnitPath), { recursive: true });
  const content = buildSystemdUnit(layout, { nodeBin });
  const tmpUnit = `${layout.systemdUnitPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpUnit, content, { mode: 0o644 });
  fs.renameSync(tmpUnit, layout.systemdUnitPath);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
}

async function restartAndVerifyService() {
  execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'restart', SERVICE_NAME], { stdio: 'inherit' });

  for (let i = 0; i < 20; i += 1) {
    const active = execFileSync('systemctl', ['--user', 'is-active', SERVICE_NAME], {
      encoding: 'utf8',
    }).trim();
    if (active === 'active') {
      const mainPid = execFileSync(
        'systemctl',
        ['--user', 'show', SERVICE_NAME, '--property=MainPID', '--value'],
        { encoding: 'utf8' },
      ).trim();
      console.log(`[release] systemd 服务已激活: ${SERVICE_NAME} (MainPID=${mainPid})`);
      return mainPid;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${SERVICE_NAME} 重启后未能进入 active 状态，请运行 \`pnpm service:logs\` 排查`);
}

function runPnpm(args, cwd) {
  execFileSync('pnpm', args, { cwd, stdio: 'inherit' });
}

export async function releaseLocal(options = {}) {
  const devRoot = path.resolve(options.devRoot ?? resolvePackageRoot());
  const layout = resolveReleaseLayout(options.gatewayHome);
  const keepCount = options.keep ?? 5;
  const nodeBin = options.nodeBin ?? process.execPath;

  const pkg = readJsonOptional(path.join(devRoot, 'package.json'));
  const version = typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.1.0';
  const gitSha = detectGitShortSha(devRoot);

  if (!options.skipTests) {
    console.log('[release] 步骤 1/6: 运行开发仓校验 (typecheck + build + test)…');
    runPnpm(['typecheck'], devRoot);
    runPnpm(['build'], devRoot);
    runPnpm(['test'], devRoot);
  } else {
    const distCli = path.join(devRoot, 'dist', 'cli.js');
    if (!fs.existsSync(distCli)) {
      console.log('[release] 未找到 dist/cli.js，先执行 pnpm build…');
      runPnpm(['build'], devRoot);
    }
  }

  bootstrapRuntimeHome(devRoot, layout);

  let releaseId = formatReleaseId(version, new Date(), gitSha);
  let releaseDir = path.join(layout.releasesDir, releaseId);
  if (fs.existsSync(releaseDir)) {
    releaseId = `${releaseId}-${process.pid}`;
    releaseDir = path.join(layout.releasesDir, releaseId);
  }

  console.log(`[release] 步骤 2/6: 创建不可变快照 ${releaseDir}`);
  fs.mkdirSync(releaseDir, { recursive: true });

  try {
    fs.copyFileSync(path.join(devRoot, 'package.json'), path.join(releaseDir, 'package.json'));
    const lockSrc = path.join(devRoot, 'pnpm-lock.yaml');
    if (fs.existsSync(lockSrc)) {
      fs.copyFileSync(lockSrc, path.join(releaseDir, 'pnpm-lock.yaml'));
    }
    const readmeSrc = path.join(devRoot, 'README.md');
    if (fs.existsSync(readmeSrc)) {
      fs.copyFileSync(readmeSrc, path.join(releaseDir, 'README.md'));
    }
    fs.cpSync(path.join(devRoot, 'dist'), path.join(releaseDir, 'dist'), { recursive: true });
    fs.chmodSync(path.join(releaseDir, 'dist', 'cli.js'), 0o755);

    const releaseMeta = {
      version,
      releaseId,
      gitSha: gitSha || null,
      sourceDir: devRoot,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(releaseDir, 'release-meta.json'),
      `${JSON.stringify(releaseMeta, null, 2)}\n`,
      'utf8',
    );

    console.log('[release] 步骤 3/6: 在快照内独立安装生产依赖 (pnpm install --prod --prefer-offline)…');
    const pnpmArgs = ['install', '--prod', '--prefer-offline'];
    if (fs.existsSync(path.join(releaseDir, 'pnpm-lock.yaml'))) {
      pnpmArgs.push('--frozen-lockfile');
    }
    runPnpm(pnpmArgs, releaseDir);

    if (!options.skipCheck) {
      console.log('[release] 步骤 4/6: 切换前预检新快照 (check)…');
      runReleaseCheck(releaseDir, layout, nodeBin);
    }

    if (!options.noSystemd) {
      installCliWrapper(layout, nodeBin);
      ensureSystemdUnitInstalled(layout, nodeBin);
    }

    console.log(`[release] 步骤 5/6: 原子切换 current -> ${releaseId}`);
    swapCurrentSymlink(layout, releaseDir);

    if (!options.noSystemd && !options.noRestart) {
      console.log('[release] 步骤 6/6: 重启并核验 systemd 用户服务…');
      await restartAndVerifyService();
    } else {
      console.log('[release] 步骤 6/6: 已按参数跳过服务重启（新版本将在下次启动/重启后生效）');
    }

    const pruned = pruneOldReleases(layout, keepCount);
    if (pruned.length > 0) {
      console.log(`[release] 已清理旧快照 (${pruned.length}): ${pruned.join(', ')}`);
    }

    return { releaseId, releaseDir, layout };
  } catch (err) {
    console.error(`[release] 发布失败，清理失败快照 ${releaseDir}`);
    fs.rmSync(releaseDir, { recursive: true, force: true });
    throw err;
  }
}

export async function rollbackLocal(targetReleaseId, options = {}) {
  const layout = resolveReleaseLayout(options.gatewayHome);
  const releases = listInstalledReleases(layout);
  const currentId = getCurrentReleaseId(layout);

  let target = targetReleaseId
    ? releases.find((r) => r.releaseId === targetReleaseId)
    : releases.find((r) => r.releaseId !== currentId);

  if (!target) {
    throw new Error(
      targetReleaseId
        ? `未找到指定历史版本: ${targetReleaseId}`
        : `没有可回滚的历史版本（当前仅存在: ${currentId ?? '无'}）`,
    );
  }

  if (!options.skipCheck) {
    console.log(`[rollback] 预检目标版本 ${target.releaseId}…`);
    runReleaseCheck(target.dir, layout, options.nodeBin ?? process.execPath);
  }

  swapCurrentSymlink(layout, target.dir);
  console.log(`[rollback] 已原子切换 current -> ${target.releaseId}`);

  if (!options.noSystemd && !options.noRestart) {
    await restartAndVerifyService();
  }

  return target;
}

export function manageService(action) {
  switch (action) {
    case 'status':
      execFileSync('systemctl', ['--user', 'status', SERVICE_NAME, '--no-pager'], {
        stdio: 'inherit',
      });
      return;
    case 'logs':
      execFileSync('journalctl', ['--user', '-u', SERVICE_NAME, '-n', '60', '--no-pager'], {
        stdio: 'inherit',
      });
      return;
    case 'follow':
      execFileSync('journalctl', ['--user', '-u', SERVICE_NAME, '-f'], { stdio: 'inherit' });
      return;
    case 'start':
    case 'stop':
    case 'restart':
    case 'enable':
    case 'disable':
      execFileSync('systemctl', ['--user', action, SERVICE_NAME], { stdio: 'inherit' });
      return;
    default:
      throw new Error(`未知 service 子命令: ${action}（支持: status | logs | follow | start | stop | restart）`);
  }
}

export function parseCliArgs(argv) {
  const flags = {
    skipTests: false,
    skipCheck: false,
    noRestart: false,
    noSystemd: false,
    keep: 5,
  };
  const positionals = [];

  for (const arg of argv) {
    if (arg === '--skip-tests') {
      flags.skipTests = true;
    } else if (arg === '--skip-check') {
      flags.skipCheck = true;
    } else if (arg === '--no-restart') {
      flags.noRestart = true;
    } else if (arg === '--no-systemd') {
      flags.noSystemd = true;
    } else if (arg.startsWith('--keep=')) {
      const parsed = Number(arg.slice('--keep='.length));
      if (Number.isInteger(parsed) && parsed >= 1) {
        flags.keep = parsed;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

async function runCli() {
  const { flags, positionals } = parseCliArgs(process.argv.slice(2));
  const cmd = (positionals[0] || 'release').toLowerCase();
  const layout = resolveReleaseLayout();

  if (cmd === 'release') {
    const res = await releaseLocal({ ...flags });
    console.log(`\n[release] 完成：${res.releaseId}`);
    return;
  }

  if (cmd === 'list') {
    const releases = listInstalledReleases(layout);
    if (releases.length === 0) {
      console.log(`暂无已发布的本地版本（目录: ${layout.releasesDir}）`);
      return;
    }
    console.log(`本地发布目录: ${layout.releasesDir}`);
    for (const r of releases) {
      const marker = r.isCurrent ? '* ' : '  ';
      console.log(`${marker}${r.releaseId}  (version=${r.version}, created=${r.createdAt})`);
    }
    return;
  }

  if (cmd === 'rollback') {
    const target = await rollbackLocal(positionals[1], flags);
    console.log(`[rollback] 完成：已切回 ${target.releaseId}`);
    return;
  }

  if (cmd === 'service') {
    manageService((positionals[1] || 'status').toLowerCase());
    return;
  }

  console.error(
    `未知子命令: ${cmd}\n用法:\n  node scripts/local-release.mjs release [--skip-tests] [--no-restart] [--no-systemd] [--keep=5]\n  node scripts/local-release.mjs list\n  node scripts/local-release.mjs rollback [releaseId]\n  node scripts/local-release.mjs service <status|logs|follow|start|stop|restart>`,
  );
  process.exit(1);
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  runCli().catch((err) => {
    console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
