import fs from 'node:fs';
import path from 'node:path';

export interface AppLockInfo {
  pid: number;
  appId: string;
  releaseId: string;
  version: string;
  rootDir: string;
  startedAt: string;
}

export class AppLockConflictError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
    readonly existing: AppLockInfo | null,
  ) {
    super(message);
    this.name = 'AppLockConflictError';
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function resolveLockFilePath(lockDir: string, appId: string): string {
  const safeAppId = appId.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(lockDir, `app-${safeAppId || 'default'}.lock`);
}

export function readLockFile(lockPath: string): AppLockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.appId !== 'string') {
      return null;
    }
    return {
      pid: parsed.pid,
      appId: parsed.appId,
      releaseId: typeof parsed.releaseId === 'string' ? parsed.releaseId : 'unknown',
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
      rootDir: typeof parsed.rootDir === 'string' ? parsed.rootDir : 'unknown',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

function buildConflictMessage(
  appId: string,
  lockPath: string,
  existing: AppLockInfo | null,
): string {
  const lines = [
    `[lock] 飞书应用 ${appId} 已有运行中的 gateway 实例，已拦截重复启动以防止抢占长连接事件：`,
  ];
  if (existing) {
    lines.push(`  - 持有者 PID : ${existing.pid}`);
    lines.push(`  - 运行版本   : ${existing.version} (${existing.releaseId})`);
    lines.push(`  - 代码目录   : ${existing.rootDir}`);
    if (existing.startedAt) {
      lines.push(`  - 启动时间   : ${existing.startedAt}`);
    }
  }
  lines.push(`  - 锁文件路径 : ${lockPath}`);
  lines.push('提示：');
  lines.push('  • 日常开发验证请用 `pnpm typecheck && pnpm build && pnpm test` 或只读 `pnpm check`（均不抢占长连接）');
  lines.push('  • 如需验证当前改动并更新线上进程，请运行 `pnpm release`');
  lines.push('  • 如需在开发仓同时运行第二个实例，请在开发仓 .env 使用独立的测试飞书应用 FEISHU_APP_ID');
  lines.push('  • 如确需手动停止托管服务，可运行 `pnpm service:stop`');
  return lines.join('\n');
}

export class AppInstanceLock {
  private released = false;

  private constructor(
    readonly lockPath: string,
    readonly info: AppLockInfo,
  ) {}

  static acquire(params: {
    lockDir: string;
    appId: string;
    releaseId: string;
    version: string;
    rootDir: string;
  }): AppInstanceLock {
    fs.mkdirSync(params.lockDir, { recursive: true });
    const lockPath = resolveLockFilePath(params.lockDir, params.appId);
    const info: AppLockInfo = {
      pid: process.pid,
      appId: params.appId,
      releaseId: params.releaseId,
      version: params.version,
      rootDir: params.rootDir,
      startedAt: new Date().toISOString(),
    };
    const payload = `${JSON.stringify(info, null, 2)}\n`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, payload, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        return new AppInstanceLock(lockPath, info);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
        const existing = readLockFile(lockPath);
        if (existing && isPidAlive(existing.pid)) {
          throw new AppLockConflictError(
            buildConflictMessage(params.appId, lockPath, existing),
            lockPath,
            existing,
          );
        }
        // Stale or corrupt lock file from a dead process: remove and retry once.
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw unlinkErr;
          }
        }
      }
    }

    const existing = readLockFile(lockPath);
    throw new AppLockConflictError(
      buildConflictMessage(params.appId, lockPath, existing),
      lockPath,
      existing,
    );
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    const current = readLockFile(this.lockPath);
    if (current && current.pid !== this.info.pid) {
      return;
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}
