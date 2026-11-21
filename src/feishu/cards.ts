import type { AcpToolEvent, AcpUsageSummary } from '../acp/client.js';

export interface FeishuCardBuildRunningParams {
  statusText: string;
  toolLines: string[];
  partialText: string;
  cwd: string;
  modelId?: string;
  thoughtLevel?: string;
}

export interface FeishuCardBuildFinalParams {
  status: 'completed' | 'cancelled' | 'error';
  text: string;
  elapsedMs: number;
  cwd: string;
  modelId?: string;
  thoughtLevel?: string;
  usage?: AcpUsageSummary;
  toolEvents?: AcpToolEvent[];
  attachmentNotes?: string[];
  errorText?: string;
  partLabel?: string;
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

function truncateTail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `…（已省略前文）\n\n${trimmed.slice(trimmed.length - maxChars)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
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
  const slice = events.slice(-limit);
  return slice.map((ev) => `${toolIcon(ev.status)} ${ev.label}`);
}

export function buildRunningCard(params: FeishuCardBuildRunningParams): Record<string, unknown> {
  const blocks: string[] = [];
  blocks.push(`**状态**：${params.statusText}`);

  if (params.toolLines.length > 0) {
    blocks.push(`**最近工具调用**\n${params.toolLines.map((line) => `- ${line}`).join('\n')}`);
  }

  const preview = truncateTail(params.partialText, 2400);
  if (preview) {
    blocks.push(`**输出预览**\n${preview}`);
  }

  const metaParts = [`工作目录：\`${params.cwd}\``];
  const modelDisplay = formatModelDisplay(params.modelId, params.thoughtLevel);
  if (modelDisplay) {
    metaParts.push(`模型：\`${modelDisplay}\``);
  }
  metaParts.push('发送 `/stop` 可随时中止');

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: 'Antigravity · 执行中',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: blocks.join('\n\n'),
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: metaParts.join(' · '),
          },
        ],
      },
    ],
  };
}

export function buildFinalCard(params: FeishuCardBuildFinalParams): Record<string, unknown> {
  let template: 'green' | 'orange' | 'red' = 'green';
  let titleText = 'Antigravity';
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

  const footerParts: string[] = [
    `目录: ${params.cwd}`,
    `耗时: ${formatDuration(params.elapsedMs)}`,
  ];
  const modelDisplay = formatModelDisplay(params.modelId, params.thoughtLevel);
  if (modelDisplay) {
    footerParts.push(`模型: ${modelDisplay}`);
  }
  if (params.toolEvents && params.toolEvents.length > 0) {
    footerParts.push(`工具调用: ${params.toolEvents.length}次`);
  }
  const usageStr = formatUsageLine(params.usage);
  if (usageStr) {
    footerParts.push(usageStr);
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: titleText,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: sections.join('\n\n'),
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: footerParts.join(' | '),
          },
        ],
      },
    ],
  };
}
