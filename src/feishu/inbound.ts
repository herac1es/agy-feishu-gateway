import fs from 'node:fs';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { FeishuGatewayClient, FeishuRawMessageReceiveEvent } from './client.js';

export interface ParsedInboundTextAndRefs {
  text: string;
  imageKeys: string[];
  fileAttachments: Array<{
    fileKey: string;
    fileName?: string;
    resourceType: 'image' | 'file';
    kindLabel: '文件' | '视频' | '音频';
  }>;
}

export interface NormalizedInboundTurn {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: string;
  rootId?: string;
  threadId?: string;
  parentId?: string;
  conversationKey: string;
  senderOpenId?: string;
  rawText: string;
  contentBlocks: acp.ContentBlock[];
  downloadedFiles: string[];
}

function inferImageMimeType(filePathOrBytes: string | Buffer): string {
  if (Buffer.isBuffer(filePathOrBytes) && filePathOrBytes.length >= 12) {
    if (
      filePathOrBytes[0] === 0x89 &&
      filePathOrBytes[1] === 0x50 &&
      filePathOrBytes[2] === 0x4e &&
      filePathOrBytes[3] === 0x47
    ) {
      return 'image/png';
    }
    if (filePathOrBytes[0] === 0xff && filePathOrBytes[1] === 0xd8) {
      return 'image/jpeg';
    }
    if (
      filePathOrBytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      filePathOrBytes.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (filePathOrBytes.subarray(0, 3).toString('ascii') === 'GIF') {
      return 'image/gif';
    }
  }
  if (typeof filePathOrBytes === 'string') {
    const ext = path.extname(filePathOrBytes).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
  }
  return 'image/jpeg';
}

function extFromMime(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

export function sanitizeFileName(rawName: string | undefined, fallback: string): string {
  const base = path.basename((rawName || '').trim());
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^\.+/, '');
  return cleaned || fallback;
}

export function sanitizeConversationDirName(conversationKey: string): string {
  const cleaned = conversationKey
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'default';
}

export function resolveInboundMessageDir(
  dataDir: string,
  conversationKey: string,
  messageId: string,
): string {
  const convDir = sanitizeConversationDirName(conversationKey);
  const msgDir = sanitizeFileName(messageId, 'message');
  return path.join(dataDir, 'inbound', convDir, msgDir);
}

export function stripFeishuMentionPlaceholders(
  text: string,
  mentions?: FeishuRawMessageReceiveEvent['message']['mentions'],
): string {
  let out = text;
  if (Array.isArray(mentions)) {
    for (const m of mentions) {
      if (m.key) {
        out = out.split(m.key).join('');
      }
    }
  }
  return out.replace(/@_user_\d+/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

export function deriveConversationKey(message: FeishuRawMessageReceiveEvent['message']): string {
  if (message.chat_type === 'p2p') {
    const threadAnchor = message.root_id || message.thread_id || message.message_id;
    return `p2p-thread:${message.chat_id}:${threadAnchor}`;
  }
  // Group chats map 1:1 with an agy session regardless of replies or threads.
  return `group:${message.chat_id}`;
}

export function parseFeishuMessageContent(
  messageType: string,
  rawContent: string,
  mentions?: FeishuRawMessageReceiveEvent['message']['mentions'],
): ParsedInboundTextAndRefs {
  let parsed: Record<string, unknown> = {};
  try {
    const obj = JSON.parse(rawContent);
    if (obj && typeof obj === 'object') {
      parsed = obj as Record<string, unknown>;
    }
  } catch {
    return {
      text: stripFeishuMentionPlaceholders(rawContent, mentions),
      imageKeys: [],
      fileAttachments: [],
    };
  }

  switch (messageType) {
    case 'text': {
      const rawText = typeof parsed.text === 'string' ? parsed.text : '';
      return {
        text: stripFeishuMentionPlaceholders(rawText, mentions),
        imageKeys: [],
        fileAttachments: [],
      };
    }

    case 'post': {
      // Feishu post payloads may be `{ title, content }` directly or `{ zh_cn: { title, content } }`.
      let postBody = parsed;
      if (!Array.isArray(parsed.content)) {
        const firstLocale = Object.values(parsed).find(
          (val) => val && typeof val === 'object' && Array.isArray((val as Record<string, unknown>).content),
        );
        if (firstLocale && typeof firstLocale === 'object') {
          postBody = firstLocale as Record<string, unknown>;
        }
      }
      const lines: string[] = [];
      const imageKeys: string[] = [];
      if (typeof postBody.title === 'string' && postBody.title.trim()) {
        lines.push(postBody.title.trim());
      }
      if (Array.isArray(postBody.content)) {
        for (const para of postBody.content) {
          if (!Array.isArray(para)) continue;
          const segments: string[] = [];
          for (const elem of para) {
            if (!elem || typeof elem !== 'object') continue;
            const node = elem as Record<string, unknown>;
            if (node.tag === 'text' && typeof node.text === 'string') {
              segments.push(node.text);
            } else if (node.tag === 'a' && typeof node.text === 'string') {
              const href = typeof node.href === 'string' ? node.href : '';
              segments.push(href ? `[${node.text}](${href})` : node.text);
            } else if (node.tag === 'at' && typeof node.user_name === 'string') {
              segments.push(`@${node.user_name}`);
            } else if (node.tag === 'img' && typeof node.image_key === 'string') {
              imageKeys.push(node.image_key);
              segments.push(`[图片 ${imageKeys.length}]`);
            }
          }
          const rowText = segments.join('').trim();
          if (rowText) {
            lines.push(rowText);
          }
        }
      }
      return {
        text: stripFeishuMentionPlaceholders(lines.join('\n'), mentions),
        imageKeys,
        fileAttachments: [],
      };
    }

    case 'image': {
      const imageKey = typeof parsed.image_key === 'string' ? parsed.image_key : '';
      return {
        text: '',
        imageKeys: imageKey ? [imageKey] : [],
        fileAttachments: [],
      };
    }

    case 'file': {
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : '';
      const fileName = typeof parsed.file_name === 'string' ? parsed.file_name : undefined;
      return {
        text: '',
        imageKeys: [],
        fileAttachments: fileKey
          ? [{ fileKey, fileName, resourceType: 'file', kindLabel: '文件' }]
          : [],
      };
    }

    case 'media': {
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : '';
      const fileName = typeof parsed.file_name === 'string' ? parsed.file_name : undefined;
      return {
        text: '',
        imageKeys: [],
        fileAttachments: fileKey
          ? [{ fileKey, fileName, resourceType: 'file', kindLabel: '视频' }]
          : [],
      };
    }

    case 'audio': {
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : '';
      return {
        text: '',
        imageKeys: [],
        fileAttachments: fileKey
          ? [{ fileKey, fileName: 'audio.opus', resourceType: 'file', kindLabel: '音频' }]
          : [],
      };
    }

    default: {
      return {
        text: `[收到未直接展开的飞书 ${messageType} 消息]\n${rawContent}`,
        imageKeys: [],
        fileAttachments: [],
      };
    }
  }
}

export async function normalizeInboundMessage(
  event: FeishuRawMessageReceiveEvent,
  options: {
    feishu: FeishuGatewayClient;
    botOpenId: string | null;
    groupRequireMention: boolean;
    dataDir: string;
  },
): Promise<NormalizedInboundTurn | null> {
  // Ignore messages sent by bots/apps to prevent self-trigger loops.
  if (event.sender?.sender_type === 'app') {
    return null;
  }

  const { message } = event;
  if (message.chat_type !== 'p2p' && options.groupRequireMention && options.botOpenId) {
    const mentionedBot = Boolean(
      message.mentions?.some((m) => m.id?.open_id === options.botOpenId),
    );
    if (!mentionedBot) {
      return null;
    }
  }

  const parsed = parseFeishuMessageContent(
    message.message_type,
    message.content,
    message.mentions,
  );

  // Pull quoted/parent message context only when replying to a distinct non-root message (skip raw interactive card JSON).
  let quotedContextText = '';
  if (message.parent_id && message.parent_id !== message.root_id) {
    const parent = await options.feishu.getMessage(message.parent_id);
    if (parent && parent.msgType !== 'interactive') {
      const parentParsed = parseFeishuMessageContent(parent.msgType, parent.content);
      if (parentParsed.text) {
        quotedContextText = `[引用消息 (${parent.messageId})]\n${parentParsed.text}`;
      }
    }
  }

  const conversationKey = deriveConversationKey(message);
  const inboundDir = resolveInboundMessageDir(options.dataDir, conversationKey, message.message_id);
  const downloadedFiles: string[] = [];
  const attachmentLines: string[] = [];
  const imageBlocks: acp.ContentBlock[] = [];

  for (let i = 0; i < parsed.imageKeys.length; i += 1) {
    const imageKey = parsed.imageKeys[i];
    const tempDest = path.join(inboundDir, `image-${i + 1}-${imageKey.slice(-6)}.bin`);
    try {
      await options.feishu.downloadMessageResource(message.message_id, imageKey, 'image', tempDest);
      const buf = fs.readFileSync(tempDest);
      const mimeType = inferImageMimeType(buf);
      const finalPath = tempDest.replace(/\.bin$/, extFromMime(mimeType));
      fs.renameSync(tempDest, finalPath);
      downloadedFiles.push(finalPath);
      attachmentLines.push(`[用户发送的图片 ${i + 1} 已保存到本地]: ${finalPath}`);
      // Keep inline base64 within conservative limits; huge images remain accessible via local path.
      if (buf.length <= 8 * 1024 * 1024) {
        imageBlocks.push({
          type: 'image',
          data: buf.toString('base64'),
          mimeType,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attachmentLines.push(`[图片 ${imageKey} 下载失败: ${msg}]`);
    }
  }

  for (let i = 0; i < parsed.fileAttachments.length; i += 1) {
    const att = parsed.fileAttachments[i];
    const safeName = sanitizeFileName(att.fileName, `attachment-${i + 1}`);
    const destPath = path.join(inboundDir, safeName);
    try {
      await options.feishu.downloadMessageResource(
        message.message_id,
        att.fileKey,
        att.resourceType,
        destPath,
      );
      const sizeBytes = fs.statSync(destPath).size;
      downloadedFiles.push(destPath);
      attachmentLines.push(
        `[用户发送的${att.kindLabel}已保存到本地]: ${destPath} (${sizeBytes} bytes)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attachmentLines.push(`[${att.kindLabel} ${safeName} 下载失败: ${msg}]`);
    }
  }

  const textParts = [quotedContextText, parsed.text, ...attachmentLines]
    .map((s) => s.trim())
    .filter(Boolean);

  if (textParts.length === 0 && imageBlocks.length === 0) {
    return null;
  }

  const combinedText = textParts.join('\n\n') || '请查看用户发送的图片。';
  const contentBlocks: acp.ContentBlock[] = [{ type: 'text', text: combinedText }, ...imageBlocks];

  return {
    eventId: event.event_id || message.message_id,
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    rootId: message.root_id,
    threadId: message.thread_id,
    parentId: message.parent_id,
    conversationKey,
    senderOpenId: event.sender?.sender_id?.open_id,
    rawText: parsed.text,
    contentBlocks,
    downloadedFiles,
  };
}
