import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/cli/chat/markdown.js';

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('renderMarkdown', () => {
  it('keeps the numbers of a list that arrives a paragraph at a time', () => {
    // How a numbered list with blank lines between its items streams in.
    const chunks = [
      '1. What is it?  \n   Suggested: a CLI',
      '2. Which checks?',
      '6. Never touch?\n7. Traces?',
    ];

    const firstLine = (chunk: string) =>
      plain(renderMarkdown(chunk)).trim().split('\n')[0]?.trimEnd();
    expect(chunks.map(firstLine)).toEqual([
      '1. What is it?',
      '2. Which checks?',
      '6. Never touch?',
    ]);
    expect(plain(renderMarkdown(chunks[2]!))).toContain('7. Traces?');
    expect(plain(renderMarkdown('1. a\n2. b\n3. c'))).toMatch(/1\. a\n\s+2\. b\n\s+3\. c/);
  });
});
