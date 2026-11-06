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

  it('nests lists by their depth, numbers only their own items, and renders their inline Markdown', () => {
    const text = [
      'Changed:',
      '- `AGENTS.md`',
      '  - a rule with **bold**',
      '- `heaw.config.ts`',
      '  - allowed:',
      '    - `run_command(git diff -- *)`',
      '    - `run_command(git status*)`',
      '',
      '1. First',
      '   - sub a',
      '   - sub b',
      '2. Second',
      '- [x] done',
    ].join('\n');

    expect(plain(renderMarkdown(text))).toBe(
      [
        'Changed:',
        '',
        '  * AGENTS.md',
        '    * a rule with bold',
        '  * heaw.config.ts',
        '    * allowed:',
        '      * run_command(git diff -- *)',
        '      * run_command(git status*)',
        '',
        '  1. First',
        '     * sub a',
        '     * sub b',
        '  2. Second',
        '',
        '  * [X] done',
      ].join('\n'),
    );
  });
});
