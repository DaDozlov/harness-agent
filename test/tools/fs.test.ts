import { utimes } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { forgetSeen } from '../../src/core/tools.js';
import {
  editFile,
  findIgnoringLineEndings,
  glob,
  grep,
  listDir,
  readFile,
  writeFile,
} from '../../src/tools/fs.js';
import { callTool, toolContext, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

async function setup(files: Record<string, string | Buffer> = {}) {
  const workspace = await tempWorkspace();
  for (const [path, content] of Object.entries(files)) await workspace.writeFile(path, content);
  return { workspace, context: toolContext(workspace) };
}

describe('read_file', () => {
  it('points to the earlier result when the same lines of an unchanged file are read again', async () => {
    const { context, workspace } = await setup({ 'a.txt': 'one\ntwo\n' });
    const read = async (args: Record<string, unknown> = {}) =>
      (await callTool(readFile, { path: 'a.txt', ...args }, context)).output;

    const first = await read();
    expect(first).toBe('     1\tone\n     2\ttwo');
    expect(await read()).toBe(
      'a.txt is unchanged since you read these lines earlier in this conversation; that ' +
        'result still has its content. Read it again only if you need it repeated.',
    );
    // Asked again, it comes: the model may need it after all.
    expect(await read()).toBe(first);
    // Other lines, a changed file, and a compacted conversation get the content.
    expect(await read({ offset: 2 })).toBe('     2\ttwo');
    await workspace.writeFile('a.txt', 'one\nTWO\n');
    expect(await read()).toBe('     1\tone\n     2\tTWO');
    expect(await read()).toContain('is unchanged');
    forgetSeen(context.state);
    expect(await read()).toBe('     1\tone\n     2\tTWO');
  });

  it('returns numbered lines', async () => {
    const { context } = await setup({ 'a.txt': 'one\ntwo\n' });

    const { output } = await callTool(readFile, { path: 'a.txt' }, context);

    expect(output).toBe('     1\tone\n     2\ttwo');
  });

  it('pages with offset and limit and says how to read on', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const { context } = await setup({ 'a.txt': lines });

    const { output } = await callTool(readFile, { path: 'a.txt', offset: 3, limit: 2 }, context);

    expect(output).toBe(
      '     3\tline 3\n     4\tline 4\n\n[Showing lines 3-4 of 10. Use offset 5 to read on.]',
    );
  });

  it('handles CRLF, a byte order mark, binary and empty files', async () => {
    const { context } = await setup({
      'crlf.txt': '\uFEFFa\r\nb\r\n',
      'image.bin': Buffer.from([0x89, 0x50, 0x00, 0x01]),
      'empty.txt': '',
    });

    expect((await callTool(readFile, { path: 'crlf.txt' }, context)).output).toBe(
      '     1\ta\n     2\tb',
    );
    expect((await callTool(readFile, { path: 'image.bin' }, context)).output).toBe(
      'image.bin is a binary file (4 bytes) and is not shown.',
    );
    expect((await callTool(readFile, { path: 'empty.txt' }, context)).output).toBe(
      'empty.txt is empty.',
    );
  });

  it('stops before the output gets too long and points to the next line', async () => {
    const { context } = await setup({ 'big.txt': Array(2_000).fill('x'.repeat(100)).join('\n') });

    const { output } = await callTool(readFile, { path: 'big.txt' }, context);

    expect(output.length).toBeLessThan(26_000);
    expect(output).toMatch(/\[Showing lines 1-\d+ of 2000\. Use offset \d+ to read on\.\]$/);
  });

  it('explains missing files, folders and paths outside the workspace', async () => {
    const { context } = await setup({ 'dir/a.txt': 'x' });

    await expect(callTool(readFile, { path: 'nope.txt' }, context)).rejects.toThrow(
      'nope.txt does not exist.',
    );
    await expect(callTool(readFile, { path: 'dir' }, context)).rejects.toThrow('is a directory');
    await expect(callTool(readFile, { path: '../outside.txt' }, context)).rejects.toThrow(
      'outside the workspace',
    );
  });
});

describe('write_file', () => {
  it('creates new files and folders without a prior read', async () => {
    const { workspace, context } = await setup();

    const { output } = await callTool(
      writeFile,
      { path: 'src/new.ts', content: 'a\nb\n' },
      context,
    );

    expect(output).toBe('Created src/new.ts (3 lines).');
    expect((await workspace.readFile('src/new.ts')).toString()).toBe('a\nb\n');
  });

  it('refuses to overwrite a file that was not read, or changed since', async () => {
    const { workspace, context } = await setup({ 'a.txt': 'old' });

    await expect(callTool(writeFile, { path: 'a.txt', content: 'new' }, context)).rejects.toThrow(
      'a.txt already exists. Read it with read_file before changing it.',
    );

    await callTool(readFile, { path: 'a.txt' }, context);
    const later = new Date(Date.now() + 5_000);
    await utimes(workspace.resolve('a.txt'), later, later);

    await expect(callTool(writeFile, { path: 'a.txt', content: 'new' }, context)).rejects.toThrow(
      'a.txt changed since you last read it',
    );
  });

  it('overwrites a file after reading it, and can write again right after', async () => {
    const { workspace, context } = await setup({ 'a.txt': 'old' });

    await callTool(readFile, { path: 'a.txt' }, context);
    await callTool(writeFile, { path: 'a.txt', content: 'new' }, context);
    const second = await callTool(writeFile, { path: 'a.txt', content: 'newer' }, context);

    expect(second.output).toBe('Replaced a.txt (1 line).');
    expect((await workspace.readFile('a.txt')).toString()).toBe('newer');
  });
});

describe('edit_file', () => {
  async function readThenEdit(content: string, args: Record<string, unknown>) {
    const { workspace, context } = await setup({ 'f.ts': content });
    await callTool(readFile, { path: 'f.ts' }, context);
    const result = await callTool(editFile, { path: 'f.ts', ...args }, context);
    return { result, after: (await workspace.readFile('f.ts')).toString() };
  }

  it('replaces a unique string and shows the edited lines', async () => {
    const { result, after } = await readThenEdit('const a = 1;\nconst b = 2;\n', {
      old_string: 'const b = 2;',
      new_string: 'const b = 3;',
    });

    expect(after).toBe('const a = 1;\nconst b = 3;\n');
    expect(result.output).toBe(
      'Edited f.ts: replaced 1 occurrence.\n     1\tconst a = 1;\n     2\tconst b = 3;\n     3\t',
    );
  });

  it('applies several edits to one file in one call, in order', async () => {
    const { result, after } = await readThenEdit('const a = 1;\nconst b = 2;\nconst c = 3;\n', {
      edits: [
        { old_string: 'const a = 1;', new_string: 'const a = 10;' },
        { old_string: 'const c = 3;', new_string: 'const c = 30;' },
        // Each edit sees the result of the ones before.
        { old_string: 'const a = 10;', new_string: 'const a = 100;' },
      ],
    });

    expect(after).toBe('const a = 100;\nconst b = 2;\nconst c = 30;\n');
    expect(result.output).toMatch(/^Edited f\.ts: applied 3 edits\.\nEdit 1:\n/);
    expect(result.output).toContain('Edit 3:\n     1\tconst a = 100;');
  });

  it('writes nothing when one of several edits does not apply, and says which', async () => {
    const { workspace, context } = await setup({ 'f.ts': 'const a = 1;\n' });
    await callTool(readFile, { path: 'f.ts' }, context);

    await expect(
      callTool(
        editFile,
        {
          path: 'f.ts',
          edits: [
            { old_string: 'const a = 1;', new_string: 'const a = 2;' },
            { old_string: 'const z = 9;', new_string: 'const z = 8;' },
          ],
        },
        context,
      ),
    ).rejects.toThrow('Edit 2 of 2: old_string was not found in f.ts.');
    expect((await workspace.readFile('f.ts')).toString()).toBe('const a = 1;\n');
    await expect(
      callTool(
        editFile,
        {
          path: 'f.ts',
          old_string: 'a',
          new_string: 'b',
          edits: [{ old_string: 'a', new_string: 'b' }],
        },
        context,
      ),
    ).rejects.toThrow('Give either old_string and new_string, or edits, not both.');
    await expect(callTool(editFile, { path: 'f.ts', old_string: 'a' }, context)).rejects.toThrow(
      'Give old_string and new_string, or a list of changes in edits.',
    );
  });

  it('keeps CRLF line endings and the byte order mark', async () => {
    const { after } = await readThenEdit('\uFEFFline one\r\nline two\r\n', {
      old_string: 'line one\nline two',
      new_string: 'line 1\nline 2',
    });

    expect(after).toBe('\uFEFFline 1\r\nline 2\r\n');
  });

  it('inserts replacement text literally, even with $ patterns', async () => {
    const { after } = await readThenEdit('price = X', { old_string: 'X', new_string: "$& and $'" });

    expect(after).toBe("price = $& and $'");
  });

  it('requires a unique match unless replace_all is set', async () => {
    await expect(readThenEdit('a a a', { old_string: 'a', new_string: 'b' })).rejects.toThrow(
      'old_string occurs 3 times in f.ts',
    );

    const { result, after } = await readThenEdit('a a a', {
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    });
    expect(after).toBe('b b b');
    expect(result.output).toMatch(/^Edited f\.ts: replaced 3 occurrences\./);
  });

  it('explains a missing match and refuses edits without a read', async () => {
    await expect(readThenEdit('hello', { old_string: 'bye', new_string: 'x' })).rejects.toThrow(
      'old_string was not found in f.ts',
    );

    const { context } = await setup({ 'g.ts': 'x' });
    await expect(
      callTool(editFile, { path: 'g.ts', old_string: 'x', new_string: 'y' }, context),
    ).rejects.toThrow('Read it with read_file before changing it.');
  });
});

describe('list_dir', () => {
  it('lists folders first, including hidden entries', async () => {
    const { context } = await setup({ 'b.txt': '', 'a.txt': '', '.env': '', 'src/x.ts': '' });

    const { output } = await callTool(listDir, {}, context);

    expect(output).toBe('src/\n.env\na.txt\nb.txt');
  });
});

describe('glob', () => {
  it('finds files by pattern, respecting .gitignore', async () => {
    const { context } = await setup({
      '.gitignore': 'dist/\n',
      'src/a.ts': '',
      'src/deep/b.ts': '',
      'src/c.js': '',
      'dist/out.ts': '',
    });
    // ripgrep only applies .gitignore inside a git repository.
    await context.workspace.exec('git init -q');

    expect((await callTool(glob, { pattern: '*.ts' }, context)).output).toBe(
      'src/a.ts\nsrc/deep/b.ts',
    );
    expect((await callTool(glob, { pattern: '*.ts', path: 'src/deep' }, context)).output).toBe(
      'src/deep/b.ts',
    );
    expect((await callTool(glob, { pattern: '*.py' }, context)).output).toBe(
      'No files match *.py.',
    );
  });

  it('finds hidden files when the pattern or path names them, and skips them otherwise', async () => {
    const { context } = await setup({
      '.heaw/agents/tester.md': 'tester',
      '.github/workflows/ci.yml': 'name: ci',
      'docs/a.md': '',
    });
    await context.workspace.exec('git init -q');

    expect((await callTool(glob, { pattern: '*.md' }, context)).output).toBe('docs/a.md');
    expect((await callTool(glob, { pattern: '.heaw/**' }, context)).output).toBe(
      '.heaw/agents/tester.md',
    );
    expect((await callTool(glob, { pattern: '*.yml', path: '.github' }, context)).output).toBe(
      '.github/workflows/ci.yml',
    );
    // `.git` stays out even then.
    const all = (await callTool(glob, { pattern: '**/.*/**' }, context)).output;
    expect(all).not.toContain('.git/');
    expect((await callTool(grep, { pattern: 'tester', glob: '.heaw/**' }, context)).output).toBe(
      '.heaw/agents/tester.md',
    );
  });
});

describe('grep', () => {
  it('lists matching files, or matching lines with numbers', async () => {
    const { context } = await setup({
      'a.ts': 'const token = 1;\nconst other = 2;\n',
      'b.md': 'Token docs\n',
    });

    expect((await callTool(grep, { pattern: 'token' }, context)).output).toBe('a.ts');
    expect((await callTool(grep, { pattern: 'token', ignore_case: true }, context)).output).toBe(
      'a.ts\nb.md',
    );
    expect((await callTool(grep, { pattern: 'other', output: 'content' }, context)).output).toBe(
      'a.ts:2:const other = 2;',
    );
    expect((await callTool(grep, { pattern: 'token', glob: '*.md' }, context)).output).toBe(
      'No matches.',
    );
  });

  it('reports an invalid regular expression', async () => {
    const { context } = await setup({ 'a.ts': 'x' });

    await expect(callTool(grep, { pattern: '(unclosed' }, context)).rejects.toThrow(/regex/i);
  });
});

describe('edit_file with mixed line endings', () => {
  it('matches text across LF and CRLF line breaks, as files written by PowerShell have', async () => {
    // A PowerShell here-string saved with Set-Content: LF inside, CRLF at the end.
    const file = 'export function add(a, b) { return a - b; }\nexport function avg() {}\r\n';
    const { workspace, context } = await setup({ 'math.js': file });
    await callTool(readFile, { path: 'math.js' }, context);

    await callTool(
      editFile,
      {
        path: 'math.js',
        old_string: 'export function add(a, b) { return a - b; }\nexport function avg() {}\n',
        new_string: 'export function add(a, b) { return a + b; }\nexport function avg() {}\n',
      },
      context,
    );

    expect((await workspace.readFile('math.js')).toString()).toBe(
      'export function add(a, b) { return a + b; }\nexport function avg() {}\r\n',
    );
  });

  it('finds matches regardless of the line-ending style', () => {
    expect(findIgnoringLineEndings('a\r\nb\nc', 'a\nb\nc')).toEqual([
      { index: 0, text: 'a\r\nb\nc' },
    ]);
    expect(findIgnoringLineEndings('x (y) x (y)', 'x (y)')).toHaveLength(2);
    expect(findIgnoringLineEndings('a\nb', 'a\r\nb')).toEqual([{ index: 0, text: 'a\nb' }]);
  });
});
