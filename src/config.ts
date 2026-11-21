import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GatewayConfig {
  rootDir: string;
  envFile: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuDomain: 'feishu' | 'lark';
  groupRequireMention: boolean;
  defaultCwd: string;
  agyBin: string;
  agyModel?: string;
  agyThoughtLevel?: string;
  dataDir: string;
  lockDir: string;
  cardUpdateIntervalMs: number;
  version: string;
  releaseId: string;
}

function parseDotEnvLine(rawLine: string): [string, string] | null {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) {
    return null;
  }
  const key = match[1];
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadDotEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (!parsed) {
      continue;
    }
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function expandUserPath(rawPath: string, baseDir?: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  return path.resolve(baseDir ?? process.cwd(), trimmed);
}

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  throw new Error(`布尔环境变量值无效: "${value}"`);
}

function readPackageMetadata(rootDir: string): { version: string; releaseId: string } {
  let version = '0.0.0';
  let releaseId = 'dev';

  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        version = pkg.version.trim();
      }
    } catch {
      // Ignore invalid optional metadata
    }
  }

  const releaseMetaPath = path.join(rootDir, 'release-meta.json');
  if (fs.existsSync(releaseMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(releaseMetaPath, 'utf8')) as { releaseId?: unknown };
      if (typeof meta.releaseId === 'string' && meta.releaseId.trim()) {
        releaseId = meta.releaseId.trim();
      }
    } catch {
      // Ignore invalid optional metadata
    }
  }

  return { version, releaseId };
}

export function resolvePackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '..');
}

export function defaultGatewayHome(): string {
  return expandUserPath(
    process.env.AGY_GATEWAY_HOME?.trim() ||
      path.join(os.homedir(), '.local', 'share', 'agy-feishu-gateway'),
    os.homedir(),
  );
}

export function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), '.agy-feishu-gateway-workspace');
}

export function loadConfig(rootDir = resolvePackageRoot()): GatewayConfig {
  const envFileOverride = process.env.AGY_GATEWAY_ENV_FILE?.trim();
  const envFile = envFileOverride
    ? expandUserPath(envFileOverride, process.cwd())
    : path.join(rootDir, '.env');

  loadDotEnv(envFile);

  const feishuAppId = process.env.FEISHU_APP_ID?.trim() ?? '';
  const feishuAppSecret = process.env.FEISHU_APP_SECRET?.trim() ?? '';
  if (!feishuAppId || !feishuAppSecret) {
    throw new Error(`缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请在 ${envFile} 中配置后重试。`);
  }

  const domainRaw = (process.env.FEISHU_DOMAIN?.trim() || 'feishu').toLowerCase();
  if (domainRaw !== 'feishu' && domainRaw !== 'lark') {
    throw new Error(`FEISHU_DOMAIN 无效: "${domainRaw}"，仅支持 feishu 或 lark`);
  }

  const groupRequireMention = parseBooleanFlag(process.env.FEISHU_GROUP_REQUIRE_MENTION, false);

  const agyBin = process.env.AGY_BIN?.trim() || 'agy';
  const agyModel = process.env.AGY_MODEL?.trim() || undefined;
  const agyThoughtLevel = process.env.AGY_THOUGHT_LEVEL?.trim() || undefined;

  const dataDirOverride = process.env.AGY_GATEWAY_DATA_DIR?.trim();
  const dataDirRaw = dataDirOverride || process.env.DATA_DIR?.trim() || '.data';
  const dataDir = expandUserPath(dataDirRaw, dataDirOverride ? process.cwd() : rootDir);

  const defaultCwdRaw = process.env.DEFAULT_CWD?.trim();
  const defaultCwd = defaultCwdRaw
    ? expandUserPath(defaultCwdRaw, rootDir)
    : defaultWorkspaceDir();
  if (!defaultCwdRaw) {
    fs.mkdirSync(defaultCwd, { recursive: true });
  } else if (!fs.existsSync(defaultCwd) || !fs.statSync(defaultCwd).isDirectory()) {
    throw new Error(`DEFAULT_CWD 不是有效目录: ${defaultCwd}`);
  }

  const lockDirOverride = process.env.AGY_GATEWAY_LOCK_DIR?.trim();
  const lockDir = lockDirOverride
    ? expandUserPath(lockDirOverride, process.cwd())
    : path.join(defaultGatewayHome(), 'locks');

  const intervalRaw = Number(process.env.CARD_UPDATE_INTERVAL_MS?.trim() || '1200');
  const cardUpdateIntervalMs =
    Number.isFinite(intervalRaw) && intervalRaw >= 400 ? Math.round(intervalRaw) : 1200;

  const { version, releaseId } = readPackageMetadata(rootDir);

  return {
    rootDir,
    envFile,
    feishuAppId,
    feishuAppSecret,
    feishuDomain: domainRaw,
    groupRequireMention,
    defaultCwd,
    agyBin,
    agyModel,
    agyThoughtLevel,
    dataDir,
    lockDir,
    cardUpdateIntervalMs,
    version,
    releaseId,
  };
}
