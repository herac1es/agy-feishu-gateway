import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { extractOutboundFileDirectives, splitLongMarkdown } from '../src/directives.js';

describe('directives & markdown helpers', () => {
  it('extracts absolute, relative, cover, and deduplicated feishu-file directives while skipping fenced blocks', () => {
    const cwd = '/tmp/coolbot-demo';
    const input = [
      '视频已渲染完成，请查收：',
      '',
      '```markdown',
      '[[feishu-file:/tmp/should-ignore-inside-backtick.png]]',
      '```',
      '',
      '~~~text',
      '[[feishu-file:/tmp/should-ignore-inside-tilde.mp4]]',
      '~~~',
      '',
      '[[feishu-file:/abs/video.mp4|cover=cover.png]]',
      '[[feishu-file:slides/slide-01.png]]',
      '[[feishu-file:slides/slide-01.png]]',
      '[[feishu-file:"/abs/with space/report.pdf"]]',
    ].join('\n');

    const result = extractOutboundFileDirectives(input, cwd);

    assert.equal(result.directives.length, 3);
    assert.deepEqual(result.directives[0], {
      filePath: '/abs/video.mp4',
      coverPath: path.resolve(cwd, 'cover.png'),
      raw: '[[feishu-file:/abs/video.mp4|cover=cover.png]]',
    });
    assert.deepEqual(result.directives[1], {
      filePath: path.resolve(cwd, 'slides/slide-01.png'),
      coverPath: undefined,
      raw: '[[feishu-file:slides/slide-01.png]]',
    });
    assert.deepEqual(result.directives[2], {
      filePath: '/abs/with space/report.pdf',
      coverPath: undefined,
      raw: '[[feishu-file:"/abs/with space/report.pdf"]]',
    });

    assert.ok(result.cleanText.includes('should-ignore-inside-backtick'));
    assert.ok(result.cleanText.includes('should-ignore-inside-tilde'));
    assert.ok(!result.cleanText.includes('/abs/video.mp4'));
    assert.ok(!result.cleanText.includes('slides/slide-01.png'));
  });

  it('splits long markdown at paragraph boundaries without exceeding maxChars', () => {
    const p1 = 'A'.repeat(60);
    const p2 = 'B'.repeat(60);
    const p3 = 'C'.repeat(60);
    const text = `${p1}\n\n${p2}\n\n${p3}`;

    const parts = splitLongMarkdown(text, 80);
    assert.equal(parts.length, 3);
    assert.equal(parts[0], p1);
    assert.equal(parts[1], p2);
    assert.equal(parts[2], p3);
  });
});
