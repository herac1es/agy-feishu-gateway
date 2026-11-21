import path from 'node:path';

export interface OutboundFileDirective {
  filePath: string;
  coverPath?: string;
  raw: string;
}

export interface ExtractedDirectivesResult {
  cleanText: string;
  directives: OutboundFileDirective[];
}

export const FEISHU_SYSTEM_PROMPT_APPEND = [
  'You are currently communicating with the user through a Feishu (Lark) bot gateway.',
  'When the user asks you to send back a generated file, screenshot, image, or rendered video (for example MP4, PNG cards, PDF, logs, or archives), output a standalone line near the end of your response using EXACTLY this syntax:',
  '[[feishu-file:/absolute/or/relative/path/to/file]]',
  'For videos with an explicit cover image, optionally append the cover path:',
  '[[feishu-file:/path/to/video.mp4|cover=/path/to/cover.png]]',
  'The gateway automatically uploads those files (up to 30MB per file, 10MB per image message) to the current Feishu chat and strips the directive lines from the visible text.',
  'Keep final answers concise and mobile-friendly (Feishu card markdown). Do not emit fake [[feishu-file:...]] paths; only emit real files that exist on disk.',
].join('\n');

const DIRECTIVE_LINE_RE = /^\s*\[\[feishu-file:([^\]]+)\]\]\s*$/;

function resolveDirectivePath(rawPath: string, cwd: string): string {
  const unquoted = rawPath.trim().replace(/^["']|["']$/g, '');
  if (path.isAbsolute(unquoted)) {
    return path.normalize(unquoted);
  }
  return path.resolve(cwd, unquoted);
}

/**
 * Extracts standalone `[[feishu-file:...]]` lines outside fenced code blocks.
 */
export function extractOutboundFileDirectives(
  markdown: string,
  cwd: string,
): ExtractedDirectivesResult {
  const lines = markdown.split(/\r?\n/);
  const keptLines: string[] = [];
  const directives: OutboundFileDirective[] = [];
  const seenPaths = new Set<string>();

  let fenceMarker: string | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const markerChar = fenceMatch[1][0];
      if (!fenceMarker) {
        fenceMarker = markerChar;
      } else if (fenceMarker === markerChar) {
        fenceMarker = null;
      }
      keptLines.push(line);
      continue;
    }

    if (fenceMarker) {
      keptLines.push(line);
      continue;
    }

    const match = line.match(DIRECTIVE_LINE_RE);
    if (!match) {
      keptLines.push(line);
      continue;
    }

    const parts = match[1]
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    const filePath = resolveDirectivePath(parts[0], cwd);
    let coverPath: string | undefined;
    for (const extra of parts.slice(1)) {
      if (extra.startsWith('cover=')) {
        const rawCover = extra.slice('cover='.length).trim();
        if (rawCover) {
          coverPath = resolveDirectivePath(rawCover, cwd);
        }
      }
    }

    if (!seenPaths.has(filePath)) {
      seenPaths.add(filePath);
      directives.push({
        filePath,
        coverPath,
        raw: line.trim(),
      });
    }
  }

  const cleanText = keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { cleanText, directives };
}

/**
 * Splits long markdown cleanly for multi-card delivery without breaking short paragraphs unnecessarily.
 */
export function splitLongMarkdown(text: string, maxChars = 10_000): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [''];
  }
  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    let splitAt = window.lastIndexOf('\n\n');
    if (splitAt < Math.floor(maxChars * 0.4)) {
      splitAt = window.lastIndexOf('\n');
    }
    if (splitAt < Math.floor(maxChars * 0.25)) {
      splitAt = maxChars;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}
