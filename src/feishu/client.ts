import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { GatewayConfig } from '../config.js';

const execFileAsync = promisify(execFile);

export const MAX_FEISHU_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FEISHU_FILE_BYTES = 30 * 1024 * 1024;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tiff', '.heic']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv']);

export interface FeishuBotInfo {
  appName: string;
  openId: string | null;
}

export interface FeishuSendTarget {
  chatId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
}

export interface FeishuMessageCotHandle {
  cotId: string;
  messageId: string;
}

export interface FeishuCotEvent {
  event_type: string;
  content: string;
  timestamp: string;
}

export interface FeishuRawMessageReceiveEvent {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      mentioned_type?: string;
      name: string;
      tenant_key?: string;
    }>;
  };
}

export interface FeishuFetchedMessage {
  messageId: string;
  msgType: string;
  content: string;
  senderType?: string;
}

export interface SentLocalFileResult {
  filePath: string;
  msgType: 'image' | 'media' | 'file';
  messageId: string;
  sizeBytes: number;
}

function mapFeishuFileType(
  filePath: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.opus') return 'opus';
  if (ext === '.mp4') return 'mp4';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc' || ext === '.docx') return 'doc';
  if (ext === '.xls' || ext === '.xlsx') return 'xls';
  if (ext === '.ppt' || ext === '.pptx') return 'ppt';
  return 'stream';
}

function assertApiOk<T extends { code?: number; msg?: string }>(action: string, res: T): T {
  if (typeof res.code === 'number' && res.code !== 0) {
    throw new Error(`飞书 ${action} 失败 (code=${res.code}): ${res.msg ?? 'unknown error'}`);
  }
  return res;
}

export function extractFeishuErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const obj = err as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
  };
  if (typeof obj.response?.data?.code === 'number') {
    return obj.response.data.code;
  }
  if (typeof obj.code === 'number') {
    return obj.code;
  }
  return undefined;
}

export function formatFeishuError(err: unknown): string {
  if (err && typeof err === 'object') {
    const obj = err as {
      message?: unknown;
      response?: { data?: { code?: unknown; msg?: unknown } };
    };
    const data = obj.response?.data;
    if (data && (typeof data.code === 'number' || typeof data.msg === 'string')) {
      return `code=${data.code ?? 'unknown'}: ${data.msg ?? obj.message ?? 'unknown error'}`;
    }
    if (typeof obj.message === 'string' && obj.message) {
      return obj.message;
    }
  }
  return String(err);
}

export function isCardKitPermissionError(err: unknown): boolean {
  const code = extractFeishuErrorCode(err);
  if (code === 99991672 || code === 300311) {
    return true;
  }
  const summary = formatFeishuError(err);
  return summary.includes('cardkit:card:write') || summary.includes('99991672');
}

async function probeVideoDurationMs(videoPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ],
      { timeout: 8000 },
    );
    const sec = Number(stdout.trim());
    if (Number.isFinite(sec) && sec > 0) {
      return Math.round(sec * 1000);
    }
  } catch {
    // ffprobe optional
  }
  return undefined;
}

async function extractVideoPosterTemp(videoPath: string): Promise<string | null> {
  const tmpPath = path.join(
    os.tmpdir(),
    `agy-feishu-cover-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`,
  );
  for (const seek of ['0.5', '0']) {
    try {
      await execFileAsync(
        'ffmpeg',
        ['-y', '-ss', seek, '-i', videoPath, '-frames:v', '1', '-q:v', '3', tmpPath],
        { timeout: 12_000 },
      );
      if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
        return tmpPath;
      }
    } catch {
      // Try next seek position or fall back to plain file attachment
    }
  }
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // ignore
  }
  return null;
}

export class FeishuGatewayClient {
  readonly api: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private readonly domain: Lark.Domain;

  constructor(private readonly config: GatewayConfig) {
    this.domain = config.feishuDomain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
    this.api = new Lark.Client({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      appType: Lark.AppType.SelfBuild,
      domain: this.domain,
      loggerLevel: Lark.LoggerLevel.warn,
    });
  }

  async getBotInfo(): Promise<FeishuBotInfo> {
    const res = await this.api.request<{
      code?: number;
      msg?: string;
      bot?: { app_name?: string; open_id?: string };
      data?: { bot?: { app_name?: string; open_id?: string } };
    }>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    assertApiOk('bot/v3/info', res);
    const bot = res.bot ?? res.data?.bot;
    return {
      appName: bot?.app_name?.trim() || 'Feishu Bot',
      openId: bot?.open_id?.trim() || null,
    };
  }

  private async sendImMessage(
    target: FeishuSendTarget,
    msgType: string,
    contentObj: Record<string, unknown>,
  ): Promise<string> {
    const content = JSON.stringify(contentObj);
    if (target.replyToMessageId) {
      const tryReply = async (replyInThread?: boolean): Promise<string> => {
        const res = assertApiOk(
          `im.v1.message.reply(${msgType})`,
          await this.api.im.v1.message.reply({
            path: { message_id: target.replyToMessageId! },
            data: {
              msg_type: msgType,
              content,
              reply_in_thread: replyInThread ? true : undefined,
            },
          }),
        );
        const msgId = res.data?.message_id;
        if (!msgId) {
          throw new Error('飞书 reply 响应缺少 message_id');
        }
        return msgId;
      };

      try {
        return await tryReply(target.replyInThread);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (target.replyInThread) {
          console.warn(`[feishu] 话题回复失败，降级为普通回复 (${msgType}): ${msg}`);
          try {
            return await tryReply(false);
          } catch (fallbackErr) {
            const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            if (!target.chatId) {
              throw fallbackErr;
            }
            console.warn(`[feishu] reply 失败，降级为 chat_id 直发 (${msgType}): ${fbMsg}`);
          }
        } else {
          if (!target.chatId) {
            throw err;
          }
          console.warn(`[feishu] reply 失败，降级为 chat_id 直发 (${msgType}): ${msg}`);
        }
      }
    }

    const res = assertApiOk(
      `im.v1.message.create(${msgType})`,
      await this.api.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: target.chatId,
          msg_type: msgType,
          content,
        },
      }),
    );
    const msgId = res.data?.message_id;
    if (!msgId) {
      throw new Error('飞书 create 响应缺少 message_id');
    }
    return msgId;
  }

  async sendCard(target: FeishuSendTarget, card: Record<string, unknown>): Promise<string> {
    return this.sendImMessage(target, 'interactive', card);
  }

  async patchCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    assertApiOk(
      'im.v1.message.patch',
      await this.api.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      }),
    );
  }

  async createCardEntity(card: Record<string, unknown>): Promise<string> {
    const res = assertApiOk(
      'cardkit.v1.card.create',
      await this.api.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(card),
        },
      }),
    );
    const cardId = res.data?.card_id;
    if (!cardId) {
      throw new Error('飞书 cardkit.v1.card.create 响应缺少 card_id');
    }
    return cardId;
  }

  async sendCardEntity(target: FeishuSendTarget, cardId: string): Promise<string> {
    return this.sendImMessage(target, 'interactive', {
      type: 'card',
      data: { card_id: cardId },
    });
  }

  async streamCardElementContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    assertApiOk(
      'cardkit.v1.cardElement.content',
      await this.api.cardkit.v1.cardElement.content({
        path: {
          card_id: cardId,
          element_id: elementId,
        },
        data: {
          content,
          sequence,
          uuid: randomUUID(),
        },
      }),
    );
  }

  async patchCardElement(
    cardId: string,
    elementId: string,
    partialElement: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    assertApiOk(
      'cardkit.v1.cardElement.patch',
      await this.api.cardkit.v1.cardElement.patch({
        path: {
          card_id: cardId,
          element_id: elementId,
        },
        data: {
          partial_element: JSON.stringify(partialElement),
          sequence,
          uuid: randomUUID(),
        },
      }),
    );
  }

  async updateCardEntity(
    cardId: string,
    card: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    assertApiOk(
      'cardkit.v1.card.update',
      await this.api.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(card),
          },
          sequence,
          uuid: randomUUID(),
        },
      }),
    );
  }

  async updateCardSettings(
    cardId: string,
    settings: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    assertApiOk(
      'cardkit.v1.card.settings',
      await this.api.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify(settings),
          sequence,
          uuid: randomUUID(),
        },
      }),
    );
  }

  async createMessageCot(
    target: FeishuSendTarget,
    options: { hidden?: boolean } = {},
  ): Promise<FeishuMessageCotHandle> {
    const attempt = async (replyInThread: boolean): Promise<FeishuMessageCotHandle> => {
      const res = assertApiOk(
        'im.v1.message_cot.create',
        await this.api.request<{
          code?: number;
          msg?: string;
          data?: { cot_id?: string; message_id?: string };
        }>({
          method: 'POST',
          url: '/open-apis/im/v1/message_cot?receive_id_type=chat_id',
          data: {
            receive_id: target.chatId,
            ...(target.replyToMessageId ? { origin_message_id: target.replyToMessageId } : {}),
            ...(replyInThread ? { reply_in_thread: true } : {}),
            cot_hidden: options.hidden === true,
            enable_badge: false,
            update_feed_rank: false,
          },
        }),
      );
      const cotId = res.data?.cot_id?.trim();
      const messageId = res.data?.message_id?.trim();
      if (!cotId || !messageId) {
        throw new Error('飞书 im.v1.message_cot.create 响应缺少 cot_id 或 message_id');
      }
      return { cotId, messageId };
    };

    if (target.replyInThread && target.replyToMessageId) {
      try {
        return await attempt(true);
      } catch (err) {
        console.warn(
          `[feishu] message_cot 话题创建失败，降级为普通创建: ${formatFeishuError(err)}`,
        );
      }
    }
    return attempt(false);
  }

  async writeMessageCotEvents(
    handle: FeishuMessageCotHandle,
    events: FeishuCotEvent[],
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }
    assertApiOk(
      'im.v1.message_cot.update',
      await this.api.request<{ code?: number; msg?: string }>({
        method: 'PUT',
        url: '/open-apis/im/v1/message_cot',
        data: {
          cot_id: handle.cotId,
          message_id: handle.messageId,
          events,
        },
      }),
    );
  }

  async completeMessageCot(handle: FeishuMessageCotHandle): Promise<void> {
    assertApiOk(
      'im.v1.message_cot.complete',
      await this.api.request<{ code?: number; msg?: string }>({
        method: 'POST',
        url: `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(handle.cotId)}`,
        params: {
          message_id: handle.messageId,
        },
        data: {},
      }),
    );
  }

  async sendText(target: FeishuSendTarget, text: string): Promise<string> {
    return this.sendImMessage(target, 'text', { text });
  }

  async getMessage(messageId: string): Promise<FeishuFetchedMessage | null> {
    try {
      const res = assertApiOk(
        'im.v1.message.get',
        await this.api.im.v1.message.get({
          path: { message_id: messageId },
        }),
      );
      const item = res.data?.items?.[0];
      if (!item?.message_id || !item.body?.content) {
        return null;
      }
      return {
        messageId: item.message_id,
        msgType: item.msg_type || 'text',
        content: item.body.content,
        senderType: item.sender?.sender_type,
      };
    } catch {
      return null;
    }
  }

  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    resourceType: 'image' | 'file',
    destPath: string,
  ): Promise<string> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const res = await this.api.im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: resourceType,
      },
    });
    if (typeof res.writeFile === 'function') {
      await res.writeFile(destPath);
      return destPath;
    }
    const stream = res.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    fs.writeFileSync(destPath, Buffer.concat(chunks));
    return destPath;
  }

  async uploadImage(imagePath: string): Promise<string> {
    const res = await this.api.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(imagePath),
      },
    });
    const imageKey =
      res?.image_key ||
      (res as { data?: { image_key?: string } } | null)?.data?.image_key ||
      '';
    if (!imageKey) {
      throw new Error(`飞书上传图片失败，未返回 image_key: ${imagePath}`);
    }
    return imageKey;
  }

  async uploadFile(
    filePath: string,
    options?: {
      fileType?: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
      fileName?: string;
      durationMs?: number;
    },
  ): Promise<string> {
    const res = await this.api.im.file.create({
      data: {
        file_type: options?.fileType ?? mapFeishuFileType(filePath),
        file_name: options?.fileName ?? path.basename(filePath),
        duration: options?.durationMs,
        file: fs.createReadStream(filePath),
      },
    });
    const fileKey =
      res?.file_key ||
      (res as { data?: { file_key?: string } } | null)?.data?.file_key ||
      '';
    if (!fileKey) {
      throw new Error(`飞书上传文件失败，未返回 file_key: ${filePath}`);
    }
    return fileKey;
  }

  async sendLocalFile(
    target: FeishuSendTarget,
    rawFilePath: string,
    options: { coverPath?: string } = {},
  ): Promise<SentLocalFileResult> {
    const absPath = path.resolve(rawFilePath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      throw new Error(`文件不存在: ${absPath}`);
    }
    const stat = fs.statSync(absPath);
    if (stat.size <= 0) {
      throw new Error(`文件为空，无法发送: ${absPath}`);
    }
    if (stat.size > MAX_FEISHU_FILE_BYTES) {
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
      throw new Error(`文件超过飞书 30MB 上限 (${sizeMb}MB): ${absPath}`);
    }

    const ext = path.extname(absPath).toLowerCase();

    // 1. Images <= 10MB go as native `image`; 10-30MB images fall back to `file`.
    if (IMAGE_EXTS.has(ext) && stat.size <= MAX_FEISHU_IMAGE_BYTES) {
      const imageKey = await this.uploadImage(absPath);
      const messageId = await this.sendImMessage(target, 'image', { image_key: imageKey });
      return { filePath: absPath, msgType: 'image', messageId, sizeBytes: stat.size };
    }

    // 2. Videos: upload mp4/stream + poster if available -> `media` (inline playable) else `file`.
    if (VIDEO_EXTS.has(ext)) {
      const durationMs = await probeVideoDurationMs(absPath);
      const fileType = ext === '.mp4' ? 'mp4' : 'stream';
      const fileKey = await this.uploadFile(absPath, {
        fileType,
        fileName: path.basename(absPath),
        durationMs,
      });

      let explicitCover = options.coverPath ? path.resolve(options.coverPath) : undefined;
      if (explicitCover && (!fs.existsSync(explicitCover) || !fs.statSync(explicitCover).isFile())) {
        explicitCover = undefined;
      }

      let generatedCover: string | null = null;
      const posterPath = explicitCover ?? (generatedCover = await extractVideoPosterTemp(absPath));
      try {
        if (posterPath && fs.statSync(posterPath).size <= MAX_FEISHU_IMAGE_BYTES) {
          const coverKey = await this.uploadImage(posterPath);
          const messageId = await this.sendImMessage(target, 'media', {
            file_key: fileKey,
            image_key: coverKey,
          });
          return { filePath: absPath, msgType: 'media', messageId, sizeBytes: stat.size };
        }
      } finally {
        if (generatedCover) {
          try {
            fs.unlinkSync(generatedCover);
          } catch {
            // ignore
          }
        }
      }

      const messageId = await this.sendImMessage(target, 'file', { file_key: fileKey });
      return { filePath: absPath, msgType: 'file', messageId, sizeBytes: stat.size };
    }

    // 3. Any other file <= 30MB
    const fileKey = await this.uploadFile(absPath);
    const messageId = await this.sendImMessage(target, 'file', { file_key: fileKey });
    return { filePath: absPath, msgType: 'file', messageId, sizeBytes: stat.size };
  }

  async startWebSocket(
    onMessage: (event: FeishuRawMessageReceiveEvent) => void | Promise<void>,
    callbacks?: {
      onReady?: () => void;
      onError?: (err: Error) => void;
      onReconnecting?: () => void;
      onReconnected?: () => void;
    },
  ): Promise<void> {
    if (this.wsClient) {
      return;
    }
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        // Dispatch asynchronously so Feishu WS ack returns immediately without blocking on agent turns.
        void Promise.resolve(onMessage(data as FeishuRawMessageReceiveEvent)).catch((err) => {
          console.error('[gateway] 未捕获的消息处理异常:', err);
        });
        return {};
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.config.feishuAppId,
      appSecret: this.config.feishuAppSecret,
      domain: this.domain,
      loggerLevel: Lark.LoggerLevel.info,
      autoReconnect: true,
      onReady: callbacks?.onReady,
      onError: callbacks?.onError,
      onReconnecting: callbacks?.onReconnecting,
      onReconnected: callbacks?.onReconnected,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  stopWebSocket(): void {
    if (!this.wsClient) {
      return;
    }
    this.wsClient.close({ force: true });
    this.wsClient = null;
  }
}
