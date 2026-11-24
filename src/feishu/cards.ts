import type { AcpToolEvent, AcpUsageSummary } from '../acp/client.js';

export const CARD_ELEMENT_IDS = {
  cotPanel: 'cot_panel',
  cotMarkdown: 'cot_md',
  replyMarkdown: 'reply_md',
  metaMarkdown: 'meta_md',
} as const;

export const SAFE_CARD_JSON_BYTES = 26_000;
export const RUNNING_COT_MAX_BYTES = 6_000;
export const RUNNING_REPLY_MAX_BYTES = 9_000;
export const FINAL_COT_MAX_BYTES = 9_000;

export interface FeishuCardBuildRunningParams {
  statusText: string;
  thoughtText?: string;
  thoughtElapsedMs?: number;
  toolLines: string[];
  toolCount?: number;
  partialText: string;
  cwd: string;
  modelId?: string;
  thoughtLevel?: string;
  streamingMode?: boolean;
}

export interface FeishuCardBuildFinalParams {
  status: 'completed' | 'cancelled' | 'error';
  headerTitle?: string;
  text: string;
  thoughtText?: string;
  thoughtElapsedMs?: number;
  elapsedMs: number;
  cwd: string;
  modelId?: string;
  thoughtLevel?: string;
  usage?: AcpUsageSummary;
  toolEvents?: AcpToolEvent[];
  attachmentNotes?: string[];
  errorText?: string;
  partLabel?: string;
  forCardKit?: boolean;
  omitCotPanel?: boolean;
}

function formatModelDisplay(modelId?: string, thoughtLevel?: string): string | null {
  if (!modelId && !thoughtLevel) {
    return null;
  }
  if (modelId && thoughtLevel) {
    return `${modelId} (${thoughtLevel})`;
  }
  return modelId ?? `思考强度:${thoughtLevel}`;
}

function balanceCodeFences(markdown: string): string {
  let openFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      openFence = !openFence;
    }
  }
  return openFence ? `${markdown}\n\`\`\`` : markdown;
}

function sliceUtf8Start(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return maxBytes <= 0 ? '' : text;
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // Avoid cutting inside a UTF-16 surrogate pair.
  if (lo > 0 && lo < text.length) {
    const code = text.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      lo -= 1;
    }
  }
  return text.slice(0, lo);
}

function sliceUtf8End(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return maxBytes <= 0 ? '' : text;
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(mid), 'utf8') <= maxBytes) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  // Avoid starting on a low surrogate.
  if (lo > 0 && lo < text.length) {
    const code = text.charCodeAt(lo);
    if (code >= 0xdc00 && code <= 0xdfff) {
      lo += 1;
    }
  }
  return text.slice(lo);
}

export function truncateUtf8Tail(text: string, maxBytes: number): string {
  const trimmed = text.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') <= maxBytes) {
    return trimmed;
  }
  const prefix = '…（已省略前文）\n\n';
  const budget = Math.max(120, maxBytes - Buffer.byteLength(prefix, 'utf8'));
  const tail = balanceCodeFences(sliceUtf8End(trimmed, budget).trimStart());
  return `${prefix}${tail}`;
}

export function truncateUtf8Head(text: string, maxBytes: number): string {
  const trimmed = text.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') <= maxBytes) {
    return trimmed;
  }
  const suffix = '\n\n…（思考过程过长，已截断）';
  const budget = Math.max(120, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  const head = balanceCodeFences(sliceUtf8Start(trimmed, budget).trimEnd());
  return `${head}${suffix}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const sec = ms / 1000;
  if (sec < 60) {
    return `${sec.toFixed(1)}s`;
  }
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m${rem}s`;
}

function formatUsageLine(usage?: AcpUsageSummary): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (typeof usage.inputTokens === 'number') {
    parts.push(`in ${usage.inputTokens}`);
  }
  if (typeof usage.outputTokens === 'number') {
    parts.push(`out ${usage.outputTokens}`);
  }
  if (typeof usage.thoughtTokens === 'number' && usage.thoughtTokens > 0) {
    parts.push(`thought ${usage.thoughtTokens}`);
  }
  if (typeof usage.totalTokens === 'number') {
    parts.push(`total ${usage.totalTokens}`);
  }
  return parts.length > 0 ? `Tokens: ${parts.join(' / ')}` : null;
}

function toolIcon(status: string): string {
  if (status === 'completed') return '✅';
  if (status === 'failed') return '❌';
  if (status === 'pending') return '⏳';
  return '⚙️';
}

export function formatToolLines(events: AcpToolEvent[], limit = 6): string[] {
  if (events.length === 0) return [];
  const slice = limit > 0 ? events.slice(-limit) : events;
  return slice.map((ev) => `${toolIcon(ev.status)} ${ev.label}`);
}

export function formatCotHeaderTitle(params: {
  running: boolean;
  hasReply: boolean;
  statusText?: string;
  thoughtElapsedMs?: number;
  hasThought: boolean;
  toolCount: number;
}): string {
  if (params.running && !params.hasReply) {
    const status = params.statusText?.trim() || '思考中…';
    return `🧠 **思考过程** · ${status}`;
  }

  const details: string[] = [];
  if (typeof params.thoughtElapsedMs === 'number' && params.thoughtElapsedMs > 0) {
    details.push(`用时 ${formatDuration(params.thoughtElapsedMs)}`);
  }
  if (params.toolCount > 0) {
    details.push(`${params.toolCount} 次工具调用`);
  }

  if (!params.hasThought && params.toolCount > 0) {
    return `⚙️ **执行过程**（${details.join(' · ')} · 点击展开）`;
  }

  if (details.length > 0) {
    return `🧠 **思考过程**（${details.join(' · ')} · 点击展开）`;
  }
  return '🧠 **思考过程**（点击展开）';
}

export function buildCotPanelHeader(titleContent: string): Record<string, unknown> {
  return {
    title: {
      tag: 'markdown',
      content: titleContent,
    },
    background_color: 'grey-50',
    vertical_align: 'center',
    padding: '4px 8px 4px 8px',
    icon: {
      tag: 'standard_icon',
      token: 'down_outlined',
      color: 'grey',
    },
    icon_position: 'right',
    icon_expanded_angle: -180,
  };
}

export function formatCotBody(params: {
  thoughtText?: string;
  toolLines?: string[];
  statusText?: string;
  maxBytes: number;
  truncateMode: 'tail' | 'head';
}): string {
  const sections: string[] = [];
  const tools = params.toolLines ?? [];
  const toolSection =
    tools.length > 0 ? `**工具调用**\n${tools.map((line) => `- ${line}`).join('\n')}` : '';
  const toolBytes = toolSection ? Buffer.byteLength(toolSection, 'utf8') + 16 : 0;
  const thoughtBudget = Math.max(240, params.maxBytes - toolBytes);

  const rawThought = params.thoughtText?.trim() ?? '';
  if (rawThought) {
    const truncated =
      params.truncateMode === 'tail'
        ? truncateUtf8Tail(rawThought, thoughtBudget)
        : truncateUtf8Head(rawThought, thoughtBudget);
    sections.push(truncated);
  }

  if (toolSection) {
    sections.push(toolSection);
  }

  if (sections.length === 0) {
    const fallback = params.statusText?.trim() || '正在思考…';
    sections.push(`_${fallback}_`);
  }

  return sections.join('\n\n');
}

function buildCotPanel(params: {
  titleContent: string;
  bodyContent: string;
  expanded: boolean;
}): Record<string, unknown> {
  return {
    tag: 'collapsible_panel',
    element_id: CARD_ELEMENT_IDS.cotPanel,
    expanded: params.expanded,
    background_color: 'grey-50',
    border: {
      color: 'grey-200',
      corner_radius: '6px',
    },
    padding: '8px 10px 8px 10px',
    vertical_spacing: '6px',
    header: buildCotPanelHeader(params.titleContent),
    elements: [
      {
        tag: 'markdown',
        element_id: CARD_ELEMENT_IDS.cotMarkdown,
        content: params.bodyContent,
        text_size: 'notation',
      },
    ],
  };
}

function buildFooterMarkdown(content: string): Record<string, unknown> {
  return {
    tag: 'markdown',
    element_id: CARD_ELEMENT_IDS.metaMarkdown,
    content: `<font color='grey'>${content}</font>`,
    text_size: 'notation',
  };
}

function buildSummaryText(raw: string, fallback: string): string {
  const oneLine = raw
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/[#>*`_\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneLine) {
    return fallback;
  }
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

export function buildRunningCard(params: FeishuCardBuildRunningParams): Record<string, unknown> {
  const hasReply = params.partialText.trim().length > 0;
  const hasThought = Boolean(params.thoughtText?.trim());
  const toolCount = params.toolCount ?? params.toolLines.length;

  const cotTitle = formatCotHeaderTitle({
    running: true,
    hasReply,
    statusText: params.statusText,
    thoughtElapsedMs: params.thoughtElapsedMs,
    hasThought,
    toolCount,
  });

  const cotBody = formatCotBody({
    thoughtText: params.thoughtText,
    toolLines: params.toolLines,
    statusText: params.statusText,
    maxBytes: RUNNING_COT_MAX_BYTES,
    truncateMode: 'tail',
  });

  const elements: Record<string, unknown>[] = [
    buildCotPanel({
      titleContent: cotTitle,
      bodyContent: cotBody,
      expanded: !hasReply,
    }),
  ];

  const replyPreview = truncateUtf8Tail(params.partialText, RUNNING_REPLY_MAX_BYTES);
  if (replyPreview || params.streamingMode) {
    elements.push({
      tag: 'markdown',
      element_id: CARD_ELEMENT_IDS.replyMarkdown,
      content: replyPreview || ' ',
    });
  }

  const metaParts = [`工作目录：\`${params.cwd}\``];
  const modelDisplay = formatModelDisplay(params.modelId, params.thoughtLevel);
  if (modelDisplay) {
    metaParts.push(`模型：\`${modelDisplay}\``);
  }
  metaParts.push('发送 `/stop` 可随时中止');
  elements.push(buildFooterMarkdown(metaParts.join(' · ')));

  const config: Record<string, unknown> = {
    update_multi: true,
    width_mode: 'fill',
    summary: {
      content: params.streamingMode ? 'Antigravity 正在思考…' : `Antigravity · ${params.statusText}`,
    },
  };

  if (params.streamingMode) {
    config.streaming_mode = true;
    config.streaming_config = {
      print_frequency_ms: { default: 50 },
      print_step: { default: 4 },
      print_strategy: 'fast',
    };
  }

  return {
    schema: '2.0',
    config,
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: hasReply ? 'Antigravity · 回复中' : 'Antigravity · 思考中',
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '8px',
      elements,
    },
  };
}

function assembleFinalCard(
  params: FeishuCardBuildFinalParams,
  cotMaxBytes: number,
  includeCotPanel: boolean,
): Record<string, unknown> {
  let template: 'green' | 'orange' | 'red' = 'green';
  let titleText = params.headerTitle?.trim() || 'Antigravity';
  if (params.status === 'cancelled') {
    template = 'orange';
    titleText = 'Antigravity · 已中止';
  } else if (params.status === 'error') {
    template = 'red';
    titleText = 'Antigravity · 执行失败';
  }
  if (params.partLabel) {
    titleText = `${titleText} (${params.partLabel})`;
  }

  const elements: Record<string, unknown>[] = [];
  const hasThought = Boolean(params.thoughtText?.trim());
  const toolEvents = params.toolEvents ?? [];
  const toolLines = formatToolLines(toolEvents, 12);

  if (includeCotPanel && (hasThought || toolLines.length > 0)) {
    const cotTitle = formatCotHeaderTitle({
      running: false,
      hasReply: true,
      thoughtElapsedMs: params.thoughtElapsedMs,
      hasThought,
      toolCount: toolEvents.length,
    });
    const cotBody = formatCotBody({
      thoughtText: params.thoughtText,
      toolLines,
      maxBytes: cotMaxBytes,
      truncateMode: 'head',
    });
    elements.push(
      buildCotPanel({
        titleContent: cotTitle,
        bodyContent: cotBody,
        expanded: false,
      }),
    );
  }

  const sections: string[] = [];
  if (params.errorText) {
    sections.push(`**错误详情**\n\`\`\`\n${params.errorText.slice(0, 2000)}\n\`\`\``);
  }

  const body = params.text.trim();
  if (body) {
    sections.push(body);
  } else if (params.status === 'cancelled') {
    sections.push('_本次回合已根据你的 `/stop` 指令中止。_');
  } else if (!params.errorText) {
    sections.push('_（本次执行未返回可见文本）_');
  }

  if (params.attachmentNotes && params.attachmentNotes.length > 0) {
    sections.push(`**附件投递**\n${params.attachmentNotes.map((n) => `- ${n}`).join('\n')}`);
  }

  elements.push({
    tag: 'markdown',
    element_id: CARD_ELEMENT_IDS.replyMarkdown,
    content: sections.join('\n\n'),
  });

  const footerParts: string[] = [
    `目录: ${params.cwd}`,
    `耗时: ${formatDuration(params.elapsedMs)}`,
  ];
  const modelDisplay = formatModelDisplay(params.modelId, params.thoughtLevel);
  if (modelDisplay) {
    footerParts.push(`模型: ${modelDisplay}`);
  }
  if (toolEvents.length > 0) {
    footerParts.push(`工具调用: ${toolEvents.length}次`);
  }
  const usageStr = formatUsageLine(params.usage);
  if (usageStr) {
    footerParts.push(usageStr);
  }

  elements.push({ tag: 'hr' });
  elements.push(buildFooterMarkdown(footerParts.join(' | ')));

  const config: Record<string, unknown> = {
    update_multi: true,
    width_mode: 'fill',
    summary: {
      content: buildSummaryText(body || params.errorText || '', titleText),
    },
  };
  if (params.forCardKit) {
    config.streaming_mode = false;
  }

  return {
    schema: '2.0',
    config,
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: titleText,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '8px',
      elements,
    },
  };
}

export function buildFinalCard(params: FeishuCardBuildFinalParams): Record<string, unknown> {
  const hasCot =
    !params.omitCotPanel &&
    (Boolean(params.thoughtText?.trim()) || Boolean(params.toolEvents?.length));
  let card = assembleFinalCard(params, FINAL_COT_MAX_BYTES, hasCot);
  if (!hasCot) {
    return card;
  }

  // Keep total serialized Card JSON safely under Feishu's 30KB payload limit.
  const budgets = [4_000, 1_500, 400];
  for (const budget of budgets) {
    if (Buffer.byteLength(JSON.stringify(card), 'utf8') <= SAFE_CARD_JSON_BYTES) {
      return card;
    }
    card = assembleFinalCard(params, budget, true);
  }

  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > SAFE_CARD_JSON_BYTES) {
    return assembleFinalCard(params, 0, false);
  }
  return card;
}

export const INBOUND_MODE_CHOICE_ACTION = 'inbound_mode_choice' as const;

export type InboundModeChoice = 'steer' | 'queue' | 'cancel';

export interface FeishuTurnModeChoiceCardParams {
  choiceId: string;
  messagePreview: string;
  attachmentSummary?: string;
  queuedCount?: number;
}

export interface FeishuTurnModeResolvedCardParams {
  outcome: 'steered' | 'queued' | 'auto_queued' | 'cancelled';
  messagePreview: string;
  attachmentSummary?: string;
  detail?: string;
}

function formatMessagePreviewBlock(messagePreview: string, attachmentSummary?: string): string {
  const preview = messagePreview.trim() || '（仅包含附件）';
  const safePreview = preview.replace(/\r?\n+/g, ' ').trim();
  const clipped = safePreview.length > 160 ? `${safePreview.slice(0, 159)}…` : safePreview;
  const lines = [`**收到新消息**\n> ${clipped}`];
  if (attachmentSummary?.trim()) {
    lines.push(`<font color='grey'>附件：${attachmentSummary.trim()}</font>`);
  }
  return lines.join('\n');
}

export function buildTurnModeChoiceCard(
  params: FeishuTurnModeChoiceCardParams,
): Record<string, unknown> {
  const hintLines = [
    '- ⚡ **引导当前任务**：立即注入当前执行中的任务，调整后续步骤',
    '- 📥 **加入排队**：等待当前任务完成后按顺序执行',
  ];
  if (typeof params.queuedCount === 'number' && params.queuedCount > 0) {
    hintLines.push(`- 当前已有 **${params.queuedCount}** 条消息在排队`);
  }

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      summary: {
        content: '任务进行中 · 请选择引导当前任务或加入排队',
      },
    },
    header: {
      template: 'wathet',
      title: {
        tag: 'plain_text',
        content: '任务进行中 · 选择新消息处理方式',
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'markdown',
          content: formatMessagePreviewBlock(params.messagePreview, params.attachmentSummary),
        },
        {
          tag: 'markdown',
          content: hintLines.join('\n'),
          text_size: 'notation',
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  type: 'primary',
                  size: 'medium',
                  text: {
                    tag: 'plain_text',
                    content: '⚡ 引导当前任务',
                  },
                  behaviors: [
                    {
                      type: 'callback',
                      value: {
                        kind: INBOUND_MODE_CHOICE_ACTION,
                        choiceId: params.choiceId,
                        mode: 'steer',
                      },
                    },
                  ],
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  type: 'default',
                  size: 'medium',
                  text: {
                    tag: 'plain_text',
                    content: '📥 加入排队',
                  },
                  behaviors: [
                    {
                      type: 'callback',
                      value: {
                        kind: INBOUND_MODE_CHOICE_ACTION,
                        choiceId: params.choiceId,
                        mode: 'queue',
                      },
                    },
                  ],
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  type: 'danger_text',
                  size: 'medium',
                  text: {
                    tag: 'plain_text',
                    content: '取消',
                  },
                  behaviors: [
                    {
                      type: 'callback',
                      value: {
                        kind: INBOUND_MODE_CHOICE_ACTION,
                        choiceId: params.choiceId,
                        mode: 'cancel',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        buildFooterMarkdown('若原任务先完成，未选择的消息将自动按排队执行 · 发送 `/stop` 可中止当前任务'),
      ],
    },
  };
}

export function buildTurnModeResolvedCard(
  params: FeishuTurnModeResolvedCardParams,
): Record<string, unknown> {
  let template: 'indigo' | 'turquoise' | 'green' | 'grey' = 'green';
  let titleText = '已处理新消息';
  let defaultDetail = '';

  switch (params.outcome) {
    case 'steered':
      template = 'indigo';
      titleText = '⚡ 已切入引导当前任务';
      defaultDetail = '已将这条消息注入当前执行中的任务，模型将在当前步骤后按新指令调整。';
      break;
    case 'queued':
      template = 'turquoise';
      titleText = '📥 已加入任务排队';
      defaultDetail = '将等待当前任务完成后按顺序执行。';
      break;
    case 'auto_queued':
      template = 'green';
      titleText = '✅ 原任务已结束 · 已自动开始执行';
      defaultDetail = '原任务已完成，这条消息已自动转入执行。';
      break;
    case 'cancelled':
      template = 'grey';
      titleText = '已取消该消息';
      defaultDetail = '已放弃提交这条消息，不影响当前任务。';
      break;
  }

  const detail = params.detail?.trim() || defaultDetail;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      summary: {
        content: titleText,
      },
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: titleText,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'markdown',
          content: formatMessagePreviewBlock(params.messagePreview, params.attachmentSummary),
        },
        {
          tag: 'markdown',
          content: `<font color='grey'>${detail}</font>`,
          text_size: 'notation',
        },
      ],
    },
  };
}
