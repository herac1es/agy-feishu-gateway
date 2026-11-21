import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseGatewayCommand, parseModelCommandArgs } from '../src/commands.js';
import type { FeishuGatewayClient, FeishuRawMessageReceiveEvent } from '../src/feishu/client.js';
import {
  deriveConversationKey,
  normalizeInboundMessage,
  parseFeishuMessageContent,
  resolveInboundMessageDir,
} from '../src/feishu/inbound.js';

describe('Feishu inbound normalization & command routing', () => {
  it('parses text, post (with images), image, file, media, and audio payloads', () => {
    const textParsed = parseFeishuMessageContent(
      'text',
      JSON.stringify({ text: '@_user_1 /cwd /tmp/demo' }),
      [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'AntigravityBot' }],
    );
    assert.equal(textParsed.text, '/cwd /tmp/demo');

    const postParsed = parseFeishuMessageContent(
      'post',
      JSON.stringify({
        zh_cn: {
          title: '报错截图',
          content: [
            [{ tag: 'text', text: '看下这张图：' }, { tag: 'img', image_key: 'img_k1' }],
            [{ tag: 'a', text: '日志', href: 'https://example.com' }],
          ],
        },
      }),
    );
    assert.ok(postParsed.text.includes('报错截图'));
    assert.ok(postParsed.text.includes('看下这张图：'));
    assert.deepEqual(postParsed.imageKeys, ['img_k1']);

    const imgParsed = parseFeishuMessageContent('image', JSON.stringify({ image_key: 'img_only' }));
    assert.deepEqual(imgParsed.imageKeys, ['img_only']);

    const fileParsed = parseFeishuMessageContent(
      'file',
      JSON.stringify({ file_key: 'file_k1', file_name: 'data.csv' }),
    );
    assert.deepEqual(fileParsed.fileAttachments, [
      { fileKey: 'file_k1', fileName: 'data.csv', resourceType: 'file', kindLabel: '文件' },
    ]);

    const mediaParsed = parseFeishuMessageContent(
      'media',
      JSON.stringify({ file_key: 'vid_k1', file_name: 'clip.mp4' }),
    );
    assert.equal(mediaParsed.fileAttachments[0]?.kindLabel, '视频');

    const audioParsed = parseFeishuMessageContent('audio', JSON.stringify({ file_key: 'aud_k1' }));
    assert.equal(audioParsed.fileAttachments[0]?.kindLabel, '音频');
  });

  it('maps group chats 1:1 regardless of threads and maps p2p chats 1:1 per topic thread', () => {
    // P2P opening message anchors its topic conversationKey on its own message_id
    assert.equal(
      deriveConversationKey({
        message_id: 'om_p2p_root_1',
        create_time: '1',
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{}',
      }),
      'p2p-thread:oc_p2p:om_p2p_root_1',
    );
    // Subsequent reply inside that P2P topic carries root_id = om_p2p_root_1 -> same session!
    assert.equal(
      deriveConversationKey({
        message_id: 'om_p2p_follow_2',
        root_id: 'om_p2p_root_1',
        thread_id: 'omt_topic_1',
        create_time: '2',
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{}',
      }),
      'p2p-thread:oc_p2p:om_p2p_root_1',
    );
    // Another top-level P2P message gets an isolated conversationKey
    assert.equal(
      deriveConversationKey({
        message_id: 'om_p2p_root_2',
        create_time: '3',
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{}',
      }),
      'p2p-thread:oc_p2p:om_p2p_root_2',
    );
    // Group chat maps 1:1 even when replies have root_id / thread_id
    assert.equal(
      deriveConversationKey({
        message_id: 'om_grp_1',
        create_time: '1',
        chat_id: 'oc_grp',
        chat_type: 'group',
        message_type: 'text',
        content: '{}',
      }),
      'group:oc_grp',
    );
    assert.equal(
      deriveConversationKey({
        message_id: 'om_grp_2',
        root_id: 'om_grp_1',
        thread_id: 'omt_grp_1',
        create_time: '2',
        chat_id: 'oc_grp',
        chat_type: 'group',
        message_type: 'text',
        content: '{}',
      }),
      'group:oc_grp',
    );
  });

  it('skips redundant root quote lookups when parent_id equals root_id inside a topic', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feishu-quote-'));
    try {
      let getCalls = 0;
      const fakeFeishu = {
        getMessage: async () => {
          getCalls += 1;
          return {
            messageId: 'om_root',
            msgType: 'text',
            content: JSON.stringify({ text: 'root message' }),
          };
        },
        downloadMessageResource: async () => '',
      } as unknown as FeishuGatewayClient;

      const normalized = await normalizeInboundMessage(
        {
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
          message: {
            message_id: 'om_follow',
            root_id: 'om_root',
            parent_id: 'om_root',
            create_time: '2',
            chat_id: 'oc_p2p',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: '继续分析' }),
          },
        },
        {
          feishu: fakeFeishu,
          botOpenId: 'ou_bot',
          groupRequireMention: false,
          dataDir: tmpDir,
        },
      );

      assert.ok(normalized);
      assert.equal(getCalls, 0);
      assert.equal(normalized.conversationKey, 'p2p-thread:oc_p2p:om_root');
      assert.equal((normalized.contentBlocks[0] as { text: string }).text, '继续分析');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('filters app self-messages while allowing arbitrary user open_ids (no code allowlist)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feishu-in-'));
    try {
      const fakeFeishu = {
        getMessage: async () => null,
        downloadMessageResource: async () => '',
      } as unknown as FeishuGatewayClient;

      const appMsg: FeishuRawMessageReceiveEvent = {
        sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } },
        message: {
          message_id: 'om_app',
          create_time: '1',
          chat_id: 'oc_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'self echo' }),
        },
      };
      assert.equal(
        await normalizeInboundMessage(appMsg, {
          feishu: fakeFeishu,
          botOpenId: 'ou_bot',
          groupRequireMention: false,
          dataDir: tmpDir,
        }),
        null,
      );

      const userMsg: FeishuRawMessageReceiveEvent = {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_any_authorized_user' } },
        message: {
          message_id: 'om_user',
          create_time: '1',
          chat_id: 'oc_chat',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '帮我跑一下单测' }),
        },
      };
      const normalized = await normalizeInboundMessage(userMsg, {
        feishu: fakeFeishu,
        botOpenId: 'ou_bot',
        groupRequireMention: false,
        dataDir: tmpDir,
      });
      assert.ok(normalized);
      assert.equal(normalized.rawText, '帮我跑一下单测');
      assert.equal(normalized.conversationKey, 'group:oc_chat');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('isolates downloaded inbound files under separate per-conversation directories', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-feishu-isolation-'));
    try {
      const fakeFeishu = {
        getMessage: async () => null,
        downloadMessageResource: async (
          _msgId: string,
          _key: string,
          _type: 'image' | 'file',
          destPath: string,
        ) => {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, 'payload', 'utf8');
          return destPath;
        },
      } as unknown as FeishuGatewayClient;

      const t1 = await normalizeInboundMessage(
        {
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
          message: {
            message_id: 'om_msg_1',
            create_time: '1',
            chat_id: 'oc_p2p',
            chat_type: 'p2p',
            message_type: 'file',
            content: JSON.stringify({ file_key: 'fk_1', file_name: 'report.txt' }),
          },
        },
        { feishu: fakeFeishu, botOpenId: 'ou_bot', groupRequireMention: false, dataDir: tmpDir },
      );

      const t2 = await normalizeInboundMessage(
        {
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
          message: {
            message_id: 'om_msg_2',
            root_id: 'om_other_topic',
            create_time: '2',
            chat_id: 'oc_p2p',
            chat_type: 'p2p',
            message_type: 'file',
            content: JSON.stringify({ file_key: 'fk_2', file_name: 'report.txt' }),
          },
        },
        { feishu: fakeFeishu, botOpenId: 'ou_bot', groupRequireMention: false, dataDir: tmpDir },
      );

      const t3 = await normalizeInboundMessage(
        {
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_2' } },
          message: {
            message_id: 'om_msg_3',
            create_time: '3',
            chat_id: 'oc_grp_99',
            chat_type: 'group',
            message_type: 'file',
            content: JSON.stringify({ file_key: 'fk_3', file_name: 'report.txt' }),
          },
        },
        { feishu: fakeFeishu, botOpenId: 'ou_bot', groupRequireMention: false, dataDir: tmpDir },
      );

      assert.ok(t1 && t2 && t3);
      assert.equal(
        t1.downloadedFiles[0],
        path.join(resolveInboundMessageDir(tmpDir, 'p2p-thread:oc_p2p:om_msg_1', 'om_msg_1'), 'report.txt'),
      );
      assert.equal(
        t2.downloadedFiles[0],
        path.join(resolveInboundMessageDir(tmpDir, 'p2p-thread:oc_p2p:om_other_topic', 'om_msg_2'), 'report.txt'),
      );
      assert.equal(
        t3.downloadedFiles[0],
        path.join(resolveInboundMessageDir(tmpDir, 'group:oc_grp_99', 'om_msg_3'), 'report.txt'),
      );
      // Verify the parent conversation folders are distinct
      assert.notEqual(
        path.dirname(path.dirname(t1.downloadedFiles[0])),
        path.dirname(path.dirname(t2.downloadedFiles[0])),
      );
      assert.notEqual(
        path.dirname(path.dirname(t1.downloadedFiles[0])),
        path.dirname(path.dirname(t3.downloadedFiles[0])),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('routes gateway slash commands and passes unknown slash commands to agy', () => {
    assert.deepEqual(parseGatewayCommand('/help'), { type: 'help' });
    assert.deepEqual(parseGatewayCommand('/status'), { type: 'status' });
    assert.deepEqual(parseGatewayCommand('/new'), { type: 'new' });
    assert.deepEqual(parseGatewayCommand('/stop'), { type: 'stop' });
    assert.deepEqual(parseGatewayCommand('/cwd "/tmp/my repo"'), {
      type: 'cwd',
      arg: '/tmp/my repo',
    });
    assert.deepEqual(parseGatewayCommand('/model gemini-4-neon'), {
      type: 'model',
      arg: 'gemini-4-neon',
    });
    assert.deepEqual(parseGatewayCommand('/send video.mp4'), {
      type: 'send',
      arg: 'video.mp4',
    });

    // Built-in AGY slash commands pass straight through as normal prompts
    assert.equal(parseGatewayCommand('/plan design a gateway'), null);
    assert.equal(parseGatewayCommand('/compact'), null);
    assert.equal(parseGatewayCommand('/goal finish EP03'), null);
    assert.equal(parseGatewayCommand('/send foo.png', true), null);

    // /model arguments parsing (model + thought_level)
    assert.deepEqual(parseModelCommandArgs(''), { kind: 'list' });
    assert.deepEqual(parseModelCommandArgs('medium'), { kind: 'set', thoughtLevel: 'medium' });
    assert.deepEqual(parseModelCommandArgs('XHIGH'), { kind: 'set', thoughtLevel: 'xhigh' });
    assert.deepEqual(parseModelCommandArgs('claude-sonnet-5-5'), {
      kind: 'set',
      modelId: 'claude-sonnet-5-5',
    });
    assert.deepEqual(parseModelCommandArgs('gemini-4-neon high'), {
      kind: 'set',
      modelId: 'gemini-4-neon',
      thoughtLevel: 'high',
    });
    assert.deepEqual(parseModelCommandArgs('gemini-4-neon:xhigh'), {
      kind: 'set',
      modelId: 'gemini-4-neon',
      thoughtLevel: 'xhigh',
    });
    assert.deepEqual(parseModelCommandArgs('claude-sonnet-5-5@medium'), {
      kind: 'set',
      modelId: 'claude-sonnet-5-5',
      thoughtLevel: 'medium',
    });
  });
});
