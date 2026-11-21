#!/usr/bin/env node
import { AgyAcpClient } from './acp/client.js';
import { loadConfig } from './config.js';
import { FeishuGatewayClient } from './feishu/client.js';
import { FeishuAcpGateway } from './gateway.js';
import { AppInstanceLock, AppLockConflictError, readLockFile, resolveLockFilePath, isPidAlive } from './lock.js';

async function runVersion(): Promise<void> {
  const config = loadConfig();
  const lockPath = resolveLockFilePath(config.lockDir, config.feishuAppId);
  const existingLock = readLockFile(lockPath);
  const activeLock = existingLock && isPidAlive(existingLock.pid) ? existingLock : null;

  console.log(`版本     : ${config.version}`);
  console.log(`发布 ID  : ${config.releaseId}`);
  console.log(`运行目录 : ${config.rootDir}`);
  console.log(`配置文件 : ${config.envFile}`);
  console.log(`数据目录 : ${config.dataDir}`);
  console.log(`默认目录 : ${config.defaultCwd}`);
  console.log(`锁目录   : ${config.lockDir}`);
  console.log(
    `运行锁   : ${activeLock ? `PID=${activeLock.pid} (${activeLock.releaseId})` : '未锁定（无运行中实例）'}`,
  );
}

async function runCheck(): Promise<void> {
  const config = loadConfig();
  console.log('=== 1. 配置核验 ===');
  console.log(`版本/发布    : ${config.version} (${config.releaseId})`);
  console.log(`代码目录     : ${config.rootDir}`);
  console.log(`配置文件     : ${config.envFile}`);
  console.log(`Feishu AppID : ${config.feishuAppId}`);
  console.log(`Feishu Domain: ${config.feishuDomain}`);
  console.log(`默认工作目录 : ${config.defaultCwd}`);
  console.log(`群聊需要 @   : ${config.groupRequireMention}`);
  console.log(`数据目录     : ${config.dataDir}`);
  console.log(`锁目录       : ${config.lockDir}`);

  console.log('\n=== 2. 飞书 OpenAPI 鉴权核验 ===');
  const feishu = new FeishuGatewayClient(config);
  const bot = await feishu.getBotInfo();
  console.log(`机器人名称   : ${bot.appName}`);
  console.log(`机器人 OpenID: ${bot.openId ?? '(未返回)'}`);

  console.log('\n=== 3. Antigravity ACP 握手核验 ===');
  const acp = new AgyAcpClient({
    agyBin: config.agyBin,
    defaultCwd: config.defaultCwd,
    logger: (m) => console.error(m),
  });
  try {
    const init = await acp.initialize();
    console.log(
      `ACP 服务端   : ${init.agentInfo?.name ?? 'Antigravity'} v${init.agentInfo?.version ?? '?'} (protocol v${init.protocolVersion})`,
    );
    console.log(
      `Session 能力 : loadSession=${Boolean(init.agentCapabilities?.loadSession)}, imagePrompt=${Boolean(init.agentCapabilities?.promptCapabilities?.image)}`,
    );
  } finally {
    await acp.shutdown();
  }

  console.log('\n=== 4. 飞书开放平台后台检查清单 ===');
  console.log('请确认已在飞书开放平台对当前应用完成以下设置并发布最新版本：');
  console.log('  1. 应用可用范围：仅限你自己（或极小私密范围），网关代码不做额外白名单拦截');
  console.log('  2. 事件与回调 -> 事件配置 -> 订阅方式：选择「使用长连接接收事件」');
  console.log('  3. 已添加事件订阅：接收消息 im.message.receive_v1');
  console.log('  4. 建议开通权限：im:message、im:message:send_as_bot、im:message.p2p_msg:readonly、im:message.group_at_msg:readonly（或 im:message.group_msg）、im:resource');
}

async function runStart(): Promise<void> {
  const config = loadConfig();

  let lock: AppInstanceLock;
  try {
    lock = AppInstanceLock.acquire({
      lockDir: config.lockDir,
      appId: config.feishuAppId,
      releaseId: config.releaseId,
      version: config.version,
      rootDir: config.rootDir,
    });
  } catch (err) {
    if (err instanceof AppLockConflictError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const feishu = new FeishuGatewayClient(config);
  const acp = new AgyAcpClient({
    agyBin: config.agyBin,
    defaultCwd: config.defaultCwd,
    logger: (m) => console.error(m),
  });
  const gateway = new FeishuAcpGateway(config, feishu, acp);

  let exiting = false;
  const shutdown = async (signal: string) => {
    if (exiting) return;
    exiting = true;
    console.log(`\n[gateway] 收到 ${signal}，正在优雅关闭…`);
    try {
      await gateway.shutdown();
    } finally {
      lock.release();
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', () => {
    lock.release();
  });

  try {
    await gateway.start();
  } catch (err) {
    lock.release();
    throw err;
  }
}

async function main(): Promise<void> {
  const subcommand = (process.argv[2] || 'start').trim().toLowerCase();
  if (subcommand === 'check') {
    await runCheck();
    return;
  }
  if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
    await runVersion();
    return;
  }
  if (subcommand === 'start') {
    await runStart();
    return;
  }
  console.error(`未知子命令: ${subcommand}（支持: start | check | version）`);
  process.exit(1);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
