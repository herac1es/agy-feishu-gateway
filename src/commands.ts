export type GatewayCommand =
  | { type: 'help' }
  | { type: 'status' }
  | { type: 'new' }
  | { type: 'stop' }
  | { type: 'cwd'; arg: string }
  | { type: 'model'; arg: string }
  | { type: 'send'; arg: string };

export type ParsedModelCommandArgs =
  | { kind: 'list' }
  | { kind: 'set'; modelId?: string; thoughtLevel?: string };

const GATEWAY_COMMANDS = new Set(['/help', '/status', '/new', '/cwd', '/model', '/stop', '/send']);
const DEFAULT_THOUGHT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'extra', 'max']);

function unquoteArg(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Parses gateway-level slash commands. Unrecognized slash commands (e.g. `/plan`, `/compact`, `/goal`)
 * return `null` so they pass straight through to the underlying `agy` session.
 */
export function parseGatewayCommand(rawText: string, hasAttachments = false): GatewayCommand | null {
  if (hasAttachments) {
    return null;
  }
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstSpace = trimmed.search(/\s/);
  const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  if (!GATEWAY_COMMANDS.has(head)) {
    return null;
  }

  const arg = firstSpace === -1 ? '' : unquoteArg(trimmed.slice(firstSpace + 1));

  switch (head) {
    case '/help':
      return { type: 'help' };
    case '/status':
      return { type: 'status' };
    case '/new':
      return { type: 'new' };
    case '/stop':
      return { type: 'stop' };
    case '/cwd':
      return { type: 'cwd', arg };
    case '/model':
      return { type: 'model', arg };
    case '/send':
      return { type: 'send', arg };
    default:
      return null;
  }
}

/**
 * Parses `/model` arguments into modelId and/or thoughtLevel:
 * - `` -> list
 * - `<thoughtLevel>` -> thoughtLevel only (e.g. `medium`, `high`, `xhigh`)
 * - `<modelId>` -> modelId only
 * - `<modelId>:<thoughtLevel>` or `<modelId>@<thoughtLevel>` or `<modelId> <thoughtLevel>` -> both
 */
export function parseModelCommandArgs(
  rawArg: string,
  knownThoughtLevels: readonly string[] = [],
): ParsedModelCommandArgs {
  const trimmed = rawArg.trim();
  if (!trimmed) {
    return { kind: 'list' };
  }

  const knownSet = new Set([
    ...DEFAULT_THOUGHT_LEVELS,
    ...knownThoughtLevels.map((t) => t.trim().toLowerCase()).filter(Boolean),
  ]);

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    return {
      kind: 'set',
      modelId: unquoteArg(tokens[0]),
      thoughtLevel: unquoteArg(tokens[1]).toLowerCase(),
    };
  }

  const single = unquoteArg(tokens[0]);
  const sepMatch = single.match(/^([^:@]+)[:@]([^:@]+)$/);
  if (sepMatch) {
    return {
      kind: 'set',
      modelId: sepMatch[1].trim(),
      thoughtLevel: sepMatch[2].trim().toLowerCase(),
    };
  }

  if (knownSet.has(single.toLowerCase())) {
    return {
      kind: 'set',
      thoughtLevel: single.toLowerCase(),
    };
  }

  return {
    kind: 'set',
    modelId: single,
  };
}

export function buildHelpText(defaultCwd: string): string {
  return [
    'Antigravity Feishu Gateway 指令说明：',
    '- 会话映射：群聊「1 个群 = 1 个 agy 会话」；私聊自动以「话题形式」回复，「1 个话题 = 1 个 agy 会话」',
    '- /status：查看当前绑定会话 ID、工作目录、模型与思考强度（私聊请发在对应话题内）',
    '- /new：关闭旧会话并立即创建新的 agy 会话（保留工作目录与模型设置）',
    `- /cwd <目录>：切换当前对话的工作目录（默认 ${defaultCwd}，会重建会话）`,
    '- /model [模型] [思考强度]：查看或切换模型与思考强度（支持 `/model medium`、`/model gemini-4-neon`、`/model gemini-4-neon high`、`/model gemini-4-neon:high`）',
    '- /stop：立即中止正在执行的回合（不排队）',
    '- 运行中追发消息：会弹出交互卡片，可选择「引导当前任务」（实时注入调整）、「加入排队」或「取消」',
    '- /send <文件路径>：直接让网关将本机文件/图片/视频发送到当前对话',
    '- 其他斜杠命令（如 /plan、/compact、/goal）与普通图文/文件消息会直接转发给 agy 执行',
  ].join('\n');
}
