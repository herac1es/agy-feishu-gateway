# Antigravity Feishu Gateway (`agy-feishu-gateway`)

轻量级 TypeScript 网关：通过**飞书 WebSocket 长连接**（无需公网 IP 或内网穿透）直连本机 **`agy acp --stdio`**。

- **完整本地 Agent 能力**：走官方 `@agentclientprotocol/sdk` ACP 协议驱动本机 `agy`，完整保留项目 `AGENTS.md`、Skills、MCP 与本地命令/文件能力。
- **最大执行权限**：使用 `--dangerously-skip-permissions --include-default-customizations`（无沙箱），并在 ACP `requestPermission` 回调中自动放行。
- **应用级权限隔离**：不在网关代码里重复写用户白名单；请直接在飞书开放平台把应用的「可用范围」限制为你本人。
- **双向富媒体与文件通道**：支持飞书发送文本/富文本/图片/文件/视频/引用消息给 `agy`，也支持 `agy` 通过回复行指令 `[[feishu-file:/path/to/file]]` 或用户直接发 `/send <path>` 回传图片、视频与文件。
- **原生飞书 COT 思考过程消息**：优先使用飞书服务端原生 `im/v1/message_cot` 接口（`POST /open-apis/im/v1/message_cot` → `PUT` 写入 AG-UI 思考与工具事件 → `POST .../complete/:cot_id` 收尾，并支持 `reply_in_thread` 留在私聊话题内），回合结束后发送简洁的最终回复卡片；若当前租户不支持原生 COT，自动降级为 Card 2.0 折叠面板模式。

---

## 开发迭代与本地发布工作流（与运行态彻底隔离）

不需要发布到远程 npm 源。开发仓的改动、编译、单测或误触发临时启动，**不会影响正在后台运行的线上网关**：

1. **目录完全隔离**：
   - **开发仓**：`/home/malishen/github.com/agy-feishu-gateway`（源码修改、`tsc` 编译、测试）。
   - **线上运行目录**：`~/.local/share/agy-feishu-gateway/`（可通过 `AGY_GATEWAY_HOME` 覆盖）：
     - `releases/<releaseId>/`：不可变发布快照（含 `dist/`、`release-meta.json` 与独立 `prod` 依赖 `node_modules/`）。
     - `current`：原子切换的当前生效版本软链。
     - `.env`（首次发版从开发仓复制，后续发版不覆盖）与 `data/`（`sessions.json` 跨版本保留不断聊；入站附件按会话隔离在 `data/inbound/<conversationKey>/<message_id>/`）；新会话默认工作目录为 `~/.agy-feishu-gateway-workspace`。
     - `locks/app-<FEISHU_APP_ID>.lock`：按飞书 AppID 互斥的单实例运行锁。
   - **全局 CLI 与系统服务**：`~/.local/bin/agy-feishu-gateway` 与 `~/.config/systemd/user/agy-feishu-gateway.service`（已启用 linger，登出终端依然常驻）。

2. **单实例防抢占锁**：
   - 当托管服务已经在跑某个 `FEISHU_APP_ID` 时，开发仓执行 `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm check` 完全安全、互不影响。
   - 若在开发仓误对**同一个 `FEISHU_APP_ID`** 执行 `pnpm start`，会被单实例锁直接拦截并拒绝启动，防止把飞书长连接事件抢走到临时进程；如需本地同时启动另一个测试机器人，只需在开发仓 `.env` 填写独立测试应用的 `FEISHU_APP_ID`。

3. **常用发版与运维命令**：

```bash
cd /home/malishen/github.com/agy-feishu-gateway

# 迭代验证（不影响运行中的后台服务）
pnpm typecheck && pnpm build && pnpm test
pnpm check

# 一键本地发布：测试 -> 打不可变快照 -> 安装 prod 依赖 -> 切换前预检 -> 原子切换 current -> 重启 systemd 服务
pnpm release

# 发布管理与回滚
pnpm release:list
pnpm release:rollback          # 自动回滚到上一版本（或传指定 releaseId）

# 托管服务与全局 CLI 查看
pnpm service:status
pnpm service:logs
pnpm service:restart
pnpm service:stop
agy-feishu-gateway version
```

---

## 飞书开放平台配置核对清单

使用 WebSocket 长连接前，请在飞书开放平台对应应用中确认：

1. **可用范围**：在「版本管理与发布 -> 可用范围」中设为仅你本人（作为全部访问隔离边界）。
2. **机器人能力**：确认「应用能力 -> 机器人」已启用。
3. **长连接订阅与卡片回调**：
   - 进入「事件与回调 -> 事件配置」，订阅方式选择 **「使用长连接接收事件」**，并订阅 **`im.message.receive_v1`**。
   - 进入「事件与回调 -> 回调配置」，订阅方式选择 **「使用长连接接收回调」**，并添加 **`card.action.trigger`**（卡片回传交互，用于运行中收到新消息时点击选择「引导当前任务 / 加入排队 / 取消」）。
4. **核心权限**：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:message.p2p_msg:readonly`（单聊消息）
   - `im:message.group_msg` 或 `im:message.group_at_msg:readonly`（群聊消息；若只用 `@机器人`，可将 `.env` 中 `FEISHU_GROUP_REQUIRE_MENTION=true`）
   - `im:resource`（收发图片、视频与文件资源）
   - `cardkit:card:write`（可选推荐：开启后自动使用 CardKit 原生流式打字机展示 CoT 思考过程；未开通时自动降级为 Card 2.0 折叠面板 + `im.v1.message.patch` 更新）
5. 修改权限或事件订阅后，务必在后台**发布新版本**使其生效。

---

## 飞书会话绑定与内建指令

- **群聊（1 群 = 1 会话）**：整个群聊绑定同一个 `agy` 会话（`group:<chatId>`）；群内发 `/status` 查看该群当前会话 ID，发 `/new` 立即关闭旧会话并创建新的 `agy` 会话。
- **私聊（话题回复 + 1 话题 = 1 会话）**：所有私聊回复均以**飞书话题**形式回复，每个话题独立绑定一个 `agy` 会话（`p2p-thread:<chatId>:<rootId>`）；话题内的 `/status`、`/new`、`/model`、`/cwd`、`/stop` 均对该话题生效。

以下 7 个网关控制指令直接由网关处理，其余斜杠指令（如 `/plan`、`/compact`、`/goal`）原样透传给 `agy`：

- `/help`：显示指令帮助
- `/status`：查看当前版本/发布 ID、PID、`sessionId`、工作目录、模型与思考强度
- `/new`：关闭旧会话并立即创建新的 `agy` 会话（保留工作目录、模型与思考强度设置）
- `/cwd <dir>`：切换当前会话工作目录（默认为 `~/.agy-feishu-gateway-workspace`）
- `/model [model] [thought]`：查看或切换模型及思考强度，支持：
  - `/model`（查看当前配置、可选模型与思考强度）
  - `/model medium`（仅切思考强度）
  - `/model claude-sonnet-5-5`（仅切模型）
  - `/model gemini-4-neon xhigh` 或 `/model gemini-4-neon:xhigh`（同时切换）
- `/stop`：立即中止正在运行的当前回合（不排队）
- `/send <path>`：让网关直接把本机文件/图片/视频发到当前飞书对话
