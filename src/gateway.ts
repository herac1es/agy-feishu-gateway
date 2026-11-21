import fs from 'node:fs';
import path from 'node:path';
import type { AcpToolEvent, AcpUsageSummary, AgyAcpClient } from './acp/client.js';
import { buildHelpText, parseGatewayCommand, parseModelCommandArgs, type GatewayCommand } from './commands.js';
import { expandUserPath, type GatewayConfig } from './config.js';
import { extractOutboundFileDirectives, splitLongMarkdown } from './directives.js';
import {
  buildCotPanelHeader,
  buildFinalCard,
  buildRunningCard,
  CARD_ELEMENT_IDS,
  formatCotBody,
  formatCotHeaderTitle,
  formatToolLines,
  RUNNING_COT_MAX_BYTES,
  RUNNING_REPLY_MAX_BYTES,
  truncateUtf8Tail,
} from './feishu/cards.js';
import {
  formatFeishuError,
  isCardKitPermissionError,
  type FeishuGatewayClient,
  type FeishuRawMessageReceiveEvent,
  type FeishuSendTarget,
} from './feishu/client.js';
import { normalizeInboundMessage, type NormalizedInboundTurn } from './feishu/inbound.js';
import { MessageDeduper, SessionStore, type ConversationSessionRecord } from './store.js';

interface InFlightTurn {
  sessionId: string;
  cancelRequested: boolean;
}

export class FeishuAcpGateway {
  private readonly store: SessionStore;
  private readonly deduper = new MessageDeduper(2000);
  private readonly queues = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<string, InFlightTurn>();
  private botOpenId: string | null = null;
  private cardKitRetryAfter = 0;
  private cardKitPermissionWarned = false;

  constructor(
    private readonly config: GatewayConfig,
    private readonly feishu: FeishuGatewayClient,
    private readonly acp: AgyAcpClient,
  ) {
    this.store = new SessionStore(config.dataDir);
  }

  async start(): Promise<void> {
    const bot = await this.feishu.getBotInfo();
    this.botOpenId = bot.openId;
    console.log(
      `[gateway] 飞书机器人已鉴权: ${bot.appName} (open_id=${bot.openId ?? 'unknown'})`,
    );

    const init = await this.acp.initialize();
    console.log(
      `[gateway] Antigravity ACP 已就绪: ${init.agentInfo?.name ?? 'agy'} v${init.agentInfo?.version ?? '?'} (--dangerously-skip-permissions)`,
    );
    console.log(
      `[gateway] 版本/发布: ${this.config.version} (${this.config.releaseId}) | PID: ${process.pid}`,
    );
    console.log(
      `[gateway] 默认工作目录: ${this.config.defaultCwd} | 群聊需要@: ${this.config.groupRequireMention ? '是' : '否'} | 代码白名单: 已关闭（依赖飞书应用后台权限隔离）`,
    );

    await this.feishu.startWebSocket((event) => this.handleRawEvent(event), {
      onReady: () => console.log('[gateway] 飞书 WebSocket 长连接已建立，等待消息…'),
      onReconnecting: () => console.log('[gateway] 飞书 WebSocket 正在重连…'),
      onReconnected: () => console.log('[gateway] 飞书 WebSocket 已恢复连接'),
      onError: (err) => console.error('[gateway] 飞书 WebSocket 错误:', err.message),
    });
  }

  async shutdown(): Promise<void> {
    this.feishu.stopWebSocket();
    await this.acp.shutdown();
  }

  private async handleRawEvent(event: FeishuRawMessageReceiveEvent): Promise<void> {
    const dedupKey = event.message?.message_id || event.event_id || '';
    if (!this.deduper.markIfNew(dedupKey)) {
      return;
    }

    const turn = await normalizeInboundMessage(event, {
      feishu: this.feishu,
      botOpenId: this.botOpenId,
      groupRequireMention: this.config.groupRequireMention,
      dataDir: this.config.dataDir,
    });
    if (!turn) {
      return;
    }

    const command = parseGatewayCommand(turn.rawText, turn.downloadedFiles.length > 0);
    if (command?.type === 'stop') {
      await this.handleStopCommand(turn);
      return;
    }

    const prev = this.queues.get(turn.conversationKey) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() =>
        command ? this.handleCommand(turn, command) : this.handlePromptTurn(turn),
      )
      .catch((err) => {
        console.error(`[gateway] 会话 ${turn.conversationKey} 处理异常:`, err);
      })
      .finally(() => {
        if (this.queues.get(turn.conversationKey) === next) {
          this.queues.delete(turn.conversationKey);
        }
      });

    this.queues.set(turn.conversationKey, next);
    await next;
  }

  private replyTargetFor(turn: NormalizedInboundTurn): FeishuSendTarget {
    if (turn.chatType === 'p2p') {
      // P2P always replies in a Feishu topic thread anchored on the opening message
      return {
        chatId: turn.chatId,
        replyToMessageId: turn.messageId,
        replyInThread: true,
      };
    }
    // Group chats stay mapped 1:1 to a single agy session; stay in thread only if user messaged from a thread
    return {
      chatId: turn.chatId,
      replyToMessageId: turn.messageId,
      replyInThread: Boolean(turn.threadId || turn.rootId),
    };
  }

  private getOrInitRecord(conversationKey: string): ConversationSessionRecord {
    return (
      this.store.get(conversationKey) ?? {
        conversationKey,
        cwd: this.config.defaultCwd,
        modelId: this.config.agyModel,
        thoughtLevel: this.config.agyThoughtLevel,
        updatedAt: new Date().toISOString(),
      }
    );
  }

  private async ensureConversationSession(
    conversationKey: string,
    record: ConversationSessionRecord,
  ) {
    const ensured = await this.acp.ensureSession({
      cwd: record.cwd,
      sessionId: record.sessionId,
      modelId: record.modelId,
      thoughtLevel: record.thoughtLevel,
    });
    const updated: ConversationSessionRecord = {
      conversationKey,
      sessionId: ensured.sessionId,
      cwd: record.cwd,
      modelId: ensured.currentModelId ?? record.modelId,
      thoughtLevel: ensured.currentThoughtLevel ?? record.thoughtLevel,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(updated);
    return { ensured, record: updated };
  }

  private async handleStopCommand(turn: NormalizedInboundTurn): Promise<void> {
    const target = this.replyTargetFor(turn);
    const active = this.inFlight.get(turn.conversationKey);
    if (!active) {
      await this.feishu.sendText(target, '当前对话没有正在运行的 Antigravity 任务。');
      return;
    }
    active.cancelRequested = true;
    await this.acp.cancel(active.sessionId);
    await this.feishu.sendText(target, '已发送中止信号，正在停止当前回合…');
  }

  private async handleCommand(turn: NormalizedInboundTurn, command: GatewayCommand): Promise<void> {
    const target = this.replyTargetFor(turn);
    const record = this.getOrInitRecord(turn.conversationKey);

    switch (command.type) {
      case 'help': {
        await this.feishu.sendText(target, buildHelpText(this.config.defaultCwd));
        return;
      }

      case 'status': {
        const running = this.inFlight.has(turn.conversationKey) ? '运行中' : '空闲';
        const scopeLabel = turn.chatType === 'p2p' ? '私聊话题 1:1 绑定' : '群聊 1:1 绑定';
        const lines = [
          `版本/发布：${this.config.version} (${this.config.releaseId}) | PID: ${process.pid}`,
          `绑定模式：${scopeLabel}`,
          `会话 Key：${turn.conversationKey}`,
          `状态：${running}`,
          `ACP Session：${record.sessionId ?? '尚未建立（发送消息或执行 /new 时自动创建）'}`,
          `工作目录：${record.cwd}`,
          `当前模型：${record.modelId ?? '默认'}`,
          `思考强度：${record.thoughtLevel ?? '默认'}`,
          `权限模式：--dangerously-skip-permissions + auto-approve（最大权限）`,
        ];
        if (turn.chatType === 'p2p' && !turn.rootId && !turn.threadId) {
          lines.push('提示：私聊按「话题」1:1 绑定会话；在具体话题内发送 /status 或 /new 可查看或重建该话题对应的会话。');
        }
        await this.feishu.sendText(target, lines.join('\n'));
        return;
      }

      case 'new': {
        if (record.sessionId) {
          await this.acp.closeSession(record.sessionId);
        }
        const resetRecord: ConversationSessionRecord = {
          ...record,
          sessionId: undefined,
          updatedAt: new Date().toISOString(),
        };
        const { ensured, record: createdRecord } = await this.ensureConversationSession(
          turn.conversationKey,
          resetRecord,
        );
        const lines = [
          `已创建新的 Antigravity 会话：${ensured.sessionId}`,
          `会话 Key：${turn.conversationKey}`,
          `工作目录：${createdRecord.cwd}`,
          `当前模型：${createdRecord.modelId ?? '默认'} | 思考强度：${createdRecord.thoughtLevel ?? '默认'}`,
        ];
        await this.feishu.sendText(target, lines.join('\n'));
        return;
      }

      case 'cwd': {
        if (!command.arg) {
          await this.feishu.sendText(target, `当前工作目录：${record.cwd}\n用法：/cwd <绝对或相对路径>`);
          return;
        }
        const resolved = expandUserPath(command.arg, record.cwd);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          await this.feishu.sendText(target, `目录不存在或不是文件夹：${resolved}`);
          return;
        }
        if (record.sessionId) {
          await this.acp.closeSession(record.sessionId);
        }
        this.store.set({
          ...record,
          cwd: resolved,
          sessionId: undefined,
          updatedAt: new Date().toISOString(),
        });
        await this.feishu.sendText(
          target,
          `工作目录已切换为：${resolved}\n上下文已重置，下条消息将在新目录启动会话。`,
        );
        return;
      }

      case 'model': {
        const { ensured, record: ensuredRecord } = await this.ensureConversationSession(
          turn.conversationKey,
          record,
        );
        const parsedArgs = parseModelCommandArgs(
          command.arg,
          ensured.availableThoughtLevels.map((t) => t.id),
        );

        if (parsedArgs.kind === 'list') {
          const thoughtSummary =
            ensured.availableThoughtLevels.length > 0
              ? ensured.availableThoughtLevels.map((t) => t.id).join(' / ')
              : '（当前模型未暴露思考强度选项）';
          const lines = [
            `当前模型：${ensuredRecord.modelId ?? '默认'}`,
            `当前思考强度：${ensuredRecord.thoughtLevel ?? '默认'}`,
            `当前模型可选思考强度：${thoughtSummary}`,
            '可用模型：',
            ...ensured.availableModels.map((m) => `- ${m.id}（${m.name}）`),
            '切换用法：',
            '- /model <模型ID>（仅切模型）',
            '- /model <思考强度>（仅切强度，如 /model medium）',
            '- /model <模型ID> <思考强度> 或 /model <模型ID>:<思考强度>（同时切换）',
          ];
          await this.feishu.sendText(target, lines.join('\n'));
          return;
        }

        try {
          const prevThought = ensuredRecord.thoughtLevel;
          const nextState = await this.acp.setSessionConfig(ensured.sessionId, {
            modelId: parsedArgs.modelId,
            thoughtLevel: parsedArgs.thoughtLevel,
            knownThoughtLevels: ensured.availableThoughtLevels,
          });
          const nextModel = nextState.currentModelId ?? parsedArgs.modelId ?? ensuredRecord.modelId;
          const nextThought =
            nextState.currentThoughtLevel ?? parsedArgs.thoughtLevel ?? ensuredRecord.thoughtLevel;

          this.store.set({
            ...ensuredRecord,
            modelId: nextModel,
            thoughtLevel: nextThought,
            updatedAt: new Date().toISOString(),
          });

          const supportedThoughts =
            nextState.availableThoughtLevels.length > 0
              ? nextState.availableThoughtLevels.map((t) => t.id).join(' / ')
              : '无';
          const lines = [
            `已更新会话模型配置（Session: ${ensured.sessionId}）：`,
            `- 模型：${nextModel ?? '默认'}`,
            `- 思考强度：${nextThought ?? '默认'}（可选：${supportedThoughts}）`,
          ];
          if (!parsedArgs.thoughtLevel && prevThought && nextThought && prevThought !== nextThought) {
            lines.push(`注：切换模型后，思考强度已从 ${prevThought} 自动调整为 ${nextThought}。`);
          }
          await this.feishu.sendText(target, lines.join('\n'));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.feishu.sendText(target, `切换模型/思考强度失败：${msg}`);
        }
        return;
      }

      case 'send': {
        if (!command.arg) {
          await this.feishu.sendText(target, '用法：/send <本机文件路径（支持相对当前工作目录）>');
          return;
        }
        const filePath = expandUserPath(command.arg, record.cwd);
        try {
          const sent = await this.feishu.sendLocalFile(target, filePath);
          await this.feishu.sendText(
            target,
            `已发送（${sent.msgType}）：${path.basename(sent.filePath)}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.feishu.sendText(target, `发送文件失败：${msg}`);
        }
        return;
      }

      case 'stop':
        return;
    }
  }

  private async handlePromptTurn(turn: NormalizedInboundTurn): Promise<void> {
    const target = this.replyTargetFor(turn);
    const record = this.getOrInitRecord(turn.conversationKey);
    const startedAt = Date.now();

    let cardId: string | null = null;
    let cardMessageId: string | null = null;
    let cardSeq = 0;
    const nextCardSeq = (): number => {
      cardSeq += 1;
      return cardSeq;
    };

    let currentModelId = record.modelId;
    let currentThoughtLevel = record.thoughtLevel;
    const initialStatusText = '正在连接 Antigravity 会话…';

    if (Date.now() >= this.cardKitRetryAfter) {
      try {
        const streamingCard = buildRunningCard({
          statusText: initialStatusText,
          thoughtText: '',
          toolLines: [],
          toolCount: 0,
          partialText: '',
          cwd: record.cwd,
          modelId: currentModelId,
          thoughtLevel: currentThoughtLevel,
          streamingMode: true,
        });
        const createdCardId = await this.feishu.createCardEntity(streamingCard);
        cardMessageId = await this.feishu.sendCardEntity(target, createdCardId);
        cardId = createdCardId;
      } catch (err) {
        if (isCardKitPermissionError(err)) {
          this.cardKitRetryAfter = Date.now() + 5 * 60_000;
          if (!this.cardKitPermissionWarned) {
            this.cardKitPermissionWarned = true;
            console.warn(
              '[gateway] 飞书应用尚未开通 cardkit:card:write，已自动降级为 Card 2.0 折叠面板 + 消息更新模式（开通该权限后将自动启用 CardKit 原生流式打字机效果）。',
            );
          }
        } else {
          console.warn(
            `[gateway] CardKit 流式卡片初始化失败，降级为普通 Card 2.0 卡片: ${formatFeishuError(err)}`,
          );
        }
        cardId = null;
      }
    }

    if (!cardMessageId) {
      try {
        cardMessageId = await this.feishu.sendCard(
          target,
          buildRunningCard({
            statusText: initialStatusText,
            thoughtText: '',
            toolLines: [],
            toolCount: 0,
            partialText: '',
            cwd: record.cwd,
            modelId: currentModelId,
            thoughtLevel: currentThoughtLevel,
          }),
        );
      } catch (err) {
        console.error('[gateway] 发送初始状态卡片失败:', err);
      }
    }

    let statusText = '思考中…';
    let thoughtText = '';
    let thoughtStartedAt: number | null = null;
    let thoughtEndedAt: number | null = null;
    let partialText = '';
    let toolEvents: AcpToolEvent[] = [];
    let usage: AcpUsageSummary = {};

    const computeThoughtElapsedMs = (): number | undefined => {
      if (!thoughtStartedAt) {
        return undefined;
      }
      const end = thoughtEndedAt ?? Date.now();
      return Math.max(1, end - thoughtStartedAt);
    };

    // Track CardKit streaming element states to avoid redundant updates.
    let lastStreamedCot = formatCotBody({
      thoughtText: '',
      toolLines: [],
      statusText: initialStatusText,
      maxBytes: RUNNING_COT_MAX_BYTES,
      truncateMode: 'tail',
    });
    let lastStreamedReply = '';
    let lastCotHeaderTitle = formatCotHeaderTitle({
      running: true,
      hasReply: false,
      statusText: initialStatusText,
      hasThought: false,
      toolCount: 0,
    });
    let cotCollapsedInStream = false;

    const updateIntervalMs = cardId
      ? Math.min(this.config.cardUpdateIntervalMs, 350)
      : this.config.cardUpdateIntervalMs;

    // Serialized card update scheduler so out-of-order updates never clobber newer text or final cards.
    let patchStopped = false;
    let dirty = false;
    let lastPatchAt = Date.now();
    let patchChain: Promise<void> = Promise.resolve();
    let timer: NodeJS.Timeout | null = null;

    const flushPatch = (): void => {
      if (patchStopped || !cardMessageId || !dirty) {
        return;
      }
      dirty = false;
      lastPatchAt = Date.now();

      const snapshotStatus = statusText;
      const snapshotThought = thoughtText;
      const snapshotThoughtElapsedMs = computeThoughtElapsedMs();
      const snapshotPartial = partialText;
      const snapshotTools = toolEvents;
      const snapshotToolLines = formatToolLines(snapshotTools);
      const activeCardId = cardId;
      const targetMsgId = cardMessageId;

      if (activeCardId) {
        const hasReply = snapshotPartial.trim().length > 0;
        const cotBody = formatCotBody({
          thoughtText: snapshotThought,
          toolLines: snapshotToolLines,
          statusText: snapshotStatus,
          maxBytes: RUNNING_COT_MAX_BYTES,
          truncateMode: 'tail',
        });
        const cotHeaderTitle = formatCotHeaderTitle({
          running: true,
          hasReply,
          statusText: snapshotStatus,
          thoughtElapsedMs: snapshotThoughtElapsedMs,
          hasThought: Boolean(snapshotThought.trim()),
          toolCount: snapshotTools.length,
        });
        const replyPreview = hasReply
          ? truncateUtf8Tail(snapshotPartial, RUNNING_REPLY_MAX_BYTES)
          : '';

        patchChain = patchChain
          .then(async () => {
            if (patchStopped) return;
            if (cotBody && cotBody !== lastStreamedCot) {
              await this.feishu.streamCardElementContent(
                activeCardId,
                CARD_ELEMENT_IDS.cotMarkdown,
                cotBody,
                nextCardSeq(),
              );
              lastStreamedCot = cotBody;
            }
            if (patchStopped) return;
            if (hasReply && !cotCollapsedInStream) {
              await this.feishu.patchCardElement(
                activeCardId,
                CARD_ELEMENT_IDS.cotPanel,
                {
                  expanded: false,
                  header: buildCotPanelHeader(cotHeaderTitle),
                },
                nextCardSeq(),
              );
              cotCollapsedInStream = true;
              lastCotHeaderTitle = cotHeaderTitle;
            } else if (!hasReply && cotHeaderTitle !== lastCotHeaderTitle) {
              await this.feishu.patchCardElement(
                activeCardId,
                CARD_ELEMENT_IDS.cotPanel,
                {
                  header: buildCotPanelHeader(cotHeaderTitle),
                },
                nextCardSeq(),
              );
              lastCotHeaderTitle = cotHeaderTitle;
            }
            if (patchStopped) return;
            if (replyPreview && replyPreview !== lastStreamedReply) {
              await this.feishu.streamCardElementContent(
                activeCardId,
                CARD_ELEMENT_IDS.replyMarkdown,
                replyPreview,
                nextCardSeq(),
              );
              lastStreamedReply = replyPreview;
            }
          })
          .catch((err) => {
            console.warn(`[gateway] 刷新 CardKit 流式卡片忽略错误: ${formatFeishuError(err)}`);
          });
        return;
      }

      const card = buildRunningCard({
        statusText: snapshotStatus,
        thoughtText: snapshotThought,
        thoughtElapsedMs: snapshotThoughtElapsedMs,
        toolLines: snapshotToolLines,
        toolCount: snapshotTools.length,
        partialText: snapshotPartial,
        cwd: record.cwd,
        modelId: currentModelId,
        thoughtLevel: currentThoughtLevel,
      });
      patchChain = patchChain
        .then(() => {
          if (!patchStopped) {
            return this.feishu.patchCard(targetMsgId, card);
          }
        })
        .catch((err) => {
          console.warn(`[gateway] 刷新流式卡片忽略错误: ${formatFeishuError(err)}`);
        });
    };

    const schedulePatch = (immediate = false): void => {
      if (patchStopped || !cardMessageId) return;
      dirty = true;
      const elapsed = Date.now() - lastPatchAt;
      if (immediate || elapsed >= updateIntervalMs) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flushPatch();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flushPatch();
        }, updateIntervalMs - elapsed);
      }
    };

    const finalizeTurnCard = async (
      finalCard: Record<string, unknown>,
      fallbackText: string,
    ): Promise<void> => {
      if (cardId) {
        try {
          const summary = (finalCard.config as { summary?: unknown } | undefined)?.summary;
          await this.feishu.updateCardSettings(
            cardId,
            {
              config: {
                streaming_mode: false,
                ...(summary ? { summary } : {}),
              },
            },
            nextCardSeq(),
          );
          await this.feishu.updateCardEntity(cardId, finalCard, nextCardSeq());
          return;
        } catch (err) {
          console.warn(
            `[gateway] CardKit 卡片收尾更新失败，尝试降级回写: ${formatFeishuError(err)}`,
          );
        }
      }

      if (cardMessageId) {
        try {
          await this.feishu.patchCard(cardMessageId, finalCard);
          return;
        } catch (err) {
          console.warn(`[gateway] patchCard 失败，降级为发送新卡片: ${formatFeishuError(err)}`);
        }
      }

      try {
        await this.feishu.sendCard(target, finalCard);
      } catch (err) {
        console.error(`[gateway] sendCard 失败，降级为纯文本回复: ${formatFeishuError(err)}`);
        await this.feishu.sendText(target, fallbackText.slice(0, 4000));
      }
    };

    let ensuredSessionId: string | null = null;

    try {
      const { ensured, record: updatedRecord } = await this.ensureConversationSession(
        turn.conversationKey,
        record,
      );
      ensuredSessionId = ensured.sessionId;
      currentModelId = updatedRecord.modelId;
      currentThoughtLevel = updatedRecord.thoughtLevel;

      this.inFlight.set(turn.conversationKey, {
        sessionId: ensured.sessionId,
        cancelRequested: false,
      });

      schedulePatch(true);

      const result = await this.acp.prompt(ensured.sessionId, turn.contentBlocks, {
        onThoughtChunk: (accumulated) => {
          if (!thoughtStartedAt) {
            thoughtStartedAt = Date.now();
          }
          thoughtText = accumulated;
          statusText = '推理规划中…';
          schedulePatch();
        },
        onTextChunk: (accumulated) => {
          if (thoughtStartedAt && !thoughtEndedAt) {
            thoughtEndedAt = Date.now();
          }
          statusText = '正在生成回复…';
          partialText = accumulated;
          schedulePatch();
        },
        onToolEvent: (ev, all) => {
          toolEvents = all;
          statusText = `执行工具：${ev.label} (${ev.status})`;
          schedulePatch();
        },
        onUsage: (u) => {
          usage = u;
        },
      });

      patchStopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await patchChain;

      const { cleanText, directives } = extractOutboundFileDirectives(result.text, record.cwd);
      const attachmentNotes: string[] = [];

      for (const dir of directives) {
        try {
          const sent = await this.feishu.sendLocalFile(target, dir.filePath, {
            coverPath: dir.coverPath,
          });
          attachmentNotes.push(`✅ 已发送（${sent.msgType}）：\`${path.basename(sent.filePath)}\``);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          attachmentNotes.push(`❌ 发送失败 \`${dir.filePath}\`：${msg}`);
        }
      }

      const chunks = splitLongMarkdown(cleanText, 6500);
      const isCancelled =
        result.stopReason === 'cancelled' ||
        Boolean(this.inFlight.get(turn.conversationKey)?.cancelRequested);

      const finalThoughtText = result.thoughtText || thoughtText;
      const finalThoughtElapsedMs = thoughtStartedAt
        ? Math.max(1, (thoughtEndedAt ?? Date.now()) - thoughtStartedAt)
        : undefined;

      const finalCard = buildFinalCard({
        status: isCancelled ? 'cancelled' : 'completed',
        text: chunks[0],
        thoughtText: finalThoughtText,
        thoughtElapsedMs: finalThoughtElapsedMs,
        elapsedMs: Date.now() - startedAt,
        cwd: record.cwd,
        modelId: currentModelId,
        thoughtLevel: currentThoughtLevel,
        usage: result.usage.totalTokens ? result.usage : usage,
        toolEvents: result.toolEvents,
        attachmentNotes: chunks.length === 1 ? attachmentNotes : undefined,
        partLabel: chunks.length > 1 ? `1/${chunks.length}` : undefined,
        forCardKit: Boolean(cardId),
      });

      await finalizeTurnCard(
        finalCard,
        chunks[0] || (isCancelled ? '本次回合已中止。' : '（本次执行未返回可见文本）'),
      );

      for (let i = 1; i < chunks.length; i += 1) {
        const isLast = i === chunks.length - 1;
        await this.feishu.sendCard(
          target,
          buildFinalCard({
            status: isCancelled ? 'cancelled' : 'completed',
            text: chunks[i],
            elapsedMs: Date.now() - startedAt,
            cwd: record.cwd,
            modelId: currentModelId,
            thoughtLevel: currentThoughtLevel,
            attachmentNotes: isLast ? attachmentNotes : undefined,
            partLabel: `${i + 1}/${chunks.length}`,
          }),
        );
      }
    } catch (err) {
      patchStopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await patchChain;

      const msg = err instanceof Error ? err.message : String(err);
      const errorCard = buildFinalCard({
        status: 'error',
        text: partialText,
        thoughtText,
        thoughtElapsedMs: computeThoughtElapsedMs(),
        elapsedMs: Date.now() - startedAt,
        cwd: record.cwd,
        modelId: currentModelId,
        thoughtLevel: currentThoughtLevel,
        usage,
        toolEvents,
        errorText: msg,
        forCardKit: Boolean(cardId),
      });

      await finalizeTurnCard(errorCard, `执行失败：${msg}`);
    } finally {
      if (ensuredSessionId) {
        this.inFlight.delete(turn.conversationKey);
      }
    }
  }
}
