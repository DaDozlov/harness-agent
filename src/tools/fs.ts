import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CONTEXT_STATE_PREFIX, type ToolContext } from '../core/tools.js';
import { defineTool } from './define.js';

const MAX_LINES = 2_000;
const MAX_LINE_CHARS = 2_000;
/** Below the engine's truncation limit, so long files are paged with offset instead of cut. */
const MAX_READ_CHARS = 25_000;
const MAX_ENTRIES = 500;
const MAX_GREP_LINES = 300;

const pathParam = z.string().describe('Path relative to the working directory, or absolute');

/**
 * Remembers which files the model has read, and their modification time then. Changing a file
 * requires a current read: it stops the model from overwriting content it has never seen or
 * that changed since (by the user or a command).
 */
function readFiles(context: ToolContext): Map<string, number> {
  let files = context.state.get('fs.readFiles') as Map<string, number> | undefined;
  if (!files) {
    files = new Map();
    context.state.set('fs.readFiles', files);
  }
  return files;
}

async function requireFreshRead(path: string, context: ToolContext): Promise<void> {
  const info = await context.workspace.stat(path);
  if (!info) return;
  const shown = context.workspace.displayPath(path);
  const readAt = readFiles(context).get(context.workspace.resolve(path));
  if (readAt === undefined) {
    throw new Error(`${shown} already exists. Read it with read_file before changing it.`);
  }
  if (info.mtimeMs > readAt) {
    throw new Error(`${shown} changed since you last read it. Read it again before changing it.`);
  }
}

async function rememberRead(path: string, context: ToolContext): Promise<void> {
  const info = await context.workspace.stat(path);
  if (info) readFiles(context).set(context.workspace.resolve(path), info.mtimeMs);
}

interface ShownRead {
  /** The file's content hash when it was shown. */
  hash: string;
  /** Whether the last identical read got the "unchanged" note instead of the content. */
  noted: boolean;
}

/**
 * The reads whose content the model was shown, by file and range. Reading the same lines of an
 * unchanged file again would add the same content to the conversation (and pay for it on every
 * later turn); the result says so instead. Cleared on compaction (`CONTEXT_STATE_PREFIX`).
 */
function shownReads(context: ToolContext): Map<string, ShownRead> {
  const key = `${CONTEXT_STATE_PREFIX}fs.shownReads`;
  let reads = context.state.get(key) as Map<string, ShownRead> | undefined;
  if (!reads) {
    reads = new Map();
    context.state.set(key, reads);
  }
  return reads;
}

const BOM = '\uFEFF';

export const readFile = defineTool({
  name: 'read_file',
  description:
    'Read a text file. Returns its lines prefixed with line numbers ("    12\\tcode"); the ' +
    `numbers are not part of the file. Reads up to ${MAX_LINES} lines; for longer files use ` +
    'offset and limit. Read a file before changing it with write_file or edit_file.',
  kind: 'read',
  subjectType: 'path',
  parameters: z.object({
    path: pathParam,
    offset: z.number().int().min(1).optional().describe('First line to read (1-based)'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Maximum lines to read (default ${MAX_LINES})`),
  }),
  subject: (args) => args.path,
  async run({ path, offset = 1, limit = MAX_LINES }, context) {
    const { workspace } = context;
    const shown = workspace.displayPath(path);
    const info = await workspace.stat(path);
    if (!info) throw new Error(`${shown} does not exist.`);
    if (info.isDirectory)
      throw new Error(`${shown} is a directory. Use list_dir to see what is in it.`);

    const buffer = await workspace.readFile(path);
    await rememberRead(path, context);
    // The same lines of an unchanged file: point to the earlier result, once. Asked again, the
    // content comes (the model may need it after all).
    const readKey = `${workspace.resolve(path)}:${offset}:${limit}`;
    const hash = createHash('sha1').update(buffer).digest('hex');
    const earlier = shownReads(context).get(readKey);
    if (earlier?.hash === hash && !earlier.noted) {
      earlier.noted = true;
      return (
        `${shown} is unchanged since you read these lines earlier in this conversation; that ` +
        'result still has its content. Read it again only if you need it repeated.'
      );
    }
    shownReads(context).set(readKey, { hash, noted: false });
    if (buffer.subarray(0, 8_000).includes(0)) {
      return `${shown} is a binary file (${info.size} bytes) and is not shown.`;
    }

    const raw = buffer.toString('utf8');
    const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
    if (text === '') return `${shown} is empty.`;
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (offset > lines.length) return `${shown} has only ${lines.length} lines.`;

    const shownLines: string[] = [];
    let chars = 0;
    let next = offset - 1;
    const end = Math.min(lines.length, next + limit);
    for (; next < end; next++) {
      let line = lines[next]!;
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)} … [line cut]`;
      const numbered = `${String(next + 1).padStart(6)}\t${line}`;
      if (chars + numbered.length > MAX_READ_CHARS && shownLines.length) break;
      shownLines.push(numbered);
      chars += numbered.length + 1;
    }
    if (next < lines.length) {
      shownLines.push(
        `\n[Showing lines ${offset}-${next} of ${lines.length}. Use offset ${next + 1} to read on.]`,
      );
    }
    return shownLines.join('\n');
  },
});

export const writeFile = defineTool({
  name: 'write_file',
  description:
    'Create a file or replace its entire content. Missing folders are created. To change part ' +
    'of an existing file, use edit_file instead. An existing file must be read first.',
  kind: 'write',
  subjectType: 'path',
  parameters: z.object({
    path: pathParam,
    content: z.string().describe('The complete new content of the file'),
  }),
  subject: (args) => args.path,
  async run({ path, content }, context) {
    const { workspace } = context;
    const shown = workspace.displayPath(path);
    const existing = await workspace.stat(path);
    if (existing?.isDirectory) throw new Error(`${shown} is a directory.`);
    await requireFreshRead(path, context);

    await workspace.writeFile(path, content);
    await rememberRead(path, context);
    const lines = content === '' ? 0 : content.split('\n').length;
    return `${existing ? 'Replaced' : 'Created'} ${shown} (${lines} line${lines === 1 ? '' : 's'}).`;
  },
});

const replacement = z.object({
  old_string: z.string().describe('The exact text to replace'),
  new_string: z.string().describe('The text to put in its place'),
  replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
});

/** Edits shown with their surrounding lines in the result; more are listed by line. */
const SNIPPETS_SHOWN = 3;

export const editFile = defineTool({
  name: 'edit_file',
  description:
    'Replace exact text in a file. old_string must match the file exactly, including ' +
    'indentation, and must be unique in the file unless replace_all is set; include a few ' +
    'surrounding lines to make it unique. Do not include the line-number prefixes shown by ' +
    'read_file. The file must be read first. For several changes to one file, pass them all ' +
    'in `edits` (applied in order, each to the result of the one before; all or none), ' +
    'instead of one call per change.',
  kind: 'write',
  subjectType: 'path',
  parameters: z.object({
    path: pathParam,
    old_string: z.string().optional().describe('The exact text to replace (one change)'),
    new_string: z.string().optional().describe('The text to put in its place (one change)'),
    replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
    edits: z
      .array(replacement)
      .min(1)
      .optional()
      .describe('Several changes to this file, instead of old_string and new_string'),
  }),
  subject: (args) => args.path,
  async run({ path, old_string, new_string, replace_all, edits }, context) {
    const { workspace } = context;
    const shown = workspace.displayPath(path);
    const changes = changesOf({ old_string, new_string, replace_all, edits });
    const info = await workspace.stat(path);
    if (!info) throw new Error(`${shown} does not exist. Use write_file to create it.`);
    if (info.isDirectory) throw new Error(`${shown} is a directory.`);
    await requireFreshRead(path, context);

    const raw = (await workspace.readFile(path)).toString('utf8');
    const bom = raw.startsWith(BOM) ? BOM : '';
    let content = raw.slice(bom.length);
    // Each edit's lines as the file was right after it: later edits may move them.
    const snippets: string[] = [];
    let count = 0;
    for (const [index, change] of changes.entries()) {
      const which = changes.length > 1 ? `Edit ${index + 1} of ${changes.length}: ` : '';
      const result = applyChange(content, change, (problem) => `${which}${problem} in ${shown}`);
      content = result.content;
      count = result.applied.count;
      snippets.push(snippet(content, result.applied.line, result.applied.lines));
    }
    await workspace.writeFile(path, bom + content);
    await rememberRead(path, context);

    if (changes.length === 1) {
      return `Edited ${shown}: replaced ${count} occurrence${count === 1 ? '' : 's'}.\n${snippets[0]}`;
    }
    const shownSnippets = snippets
      .slice(0, SNIPPETS_SHOWN)
      .map((text, index) => `Edit ${index + 1}:\n${text}`);
    const more =
      snippets.length > SNIPPETS_SHOWN ? `\n(${snippets.length - SNIPPETS_SHOWN} more)` : '';
    return `Edited ${shown}: applied ${snippets.length} edits.\n${shownSnippets.join('\n')}${more}`;
  },
});

type Replacement = z.infer<typeof replacement>;

/** The changes a call asks for: one pair, or a list; never both or neither. */
function changesOf(args: Partial<Replacement> & { edits?: Replacement[] | undefined }) {
  const single = args.old_string !== undefined || args.new_string !== undefined;
  if (args.edits && single) {
    throw new Error('Give either old_string and new_string, or edits, not both.');
  }
  if (args.edits) return args.edits;
  if (args.old_string === undefined || args.new_string === undefined) {
    throw new Error('Give old_string and new_string, or a list of changes in edits.');
  }
  return [
    { old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all },
  ];
}

/** Applies one replacement; `where` turns a problem into the error message. */
function applyChange(
  content: string,
  { old_string, new_string, replace_all = false }: Replacement,
  where: (problem: string) => string,
): { content: string; applied: { line: number; lines: number; count: number } } {
  if (old_string === '') {
    throw new Error(`${where('old_string is empty')}. Use write_file to create a file.`);
  }
  if (old_string === new_string)
    throw new Error(`${where('old_string and new_string are the same')}.`);
  const matches = findIgnoringLineEndings(content, old_string);
  if (matches.length === 0) {
    throw new Error(
      `${where('old_string was not found')}. Read the file again and copy the text exactly, ` +
        'including whitespace and indentation.',
    );
  }
  if (matches.length > 1 && !replace_all) {
    throw new Error(
      `${where(`old_string occurs ${matches.length} times`)}. Include more surrounding lines to ` +
        'make it unique, or set replace_all to replace every occurrence.',
    );
  }
  // Replace from the end, so earlier match positions stay valid.
  const chosen = replace_all ? matches : matches.slice(0, 1);
  let updated = content;
  for (const match of [...chosen].reverse()) {
    const text = withLineEndingsOf(new_string, match.text, content);
    updated = updated.slice(0, match.index) + text + updated.slice(match.index + match.text.length);
  }
  const line = content.slice(0, chosen[0]!.index).split('\n').length;
  return {
    content: updated,
    applied: { line, lines: new_string.split('\n').length, count: chosen.length },
  };
}

/**
 * Finds `target` in `content`, treating every line break as either \n or \r\n. The model sees
 * files without \r (read_file strips it), and real files have CRLF, LF or a mix of both, e.g.
 * after editors or git line-ending settings disagreed.
 */
export function findIgnoringLineEndings(
  content: string,
  target: string,
): Array<{ index: number; text: string }> {
  const pattern = target
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\r?\\n');
  return [...content.matchAll(new RegExp(pattern, 'g'))].map((match) => ({
    index: match.index,
    text: match[0],
  }));
}

/**
 * Gives `text` the line breaks of the text it replaces, line by line, so an edit never changes
 * line endings it did not touch. Extra lines get the last break of the replaced text, or the
 * file's usual one.
 */
function withLineEndingsOf(text: string, replaced: string, content: string): string {
  const breaks = replaced.match(/\r?\n/g) ?? [];
  const fallback = breaks.at(-1) ?? usualLineEnding(content);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return lines
    .map((line, index) => (index < lines.length - 1 ? line + (breaks[index] ?? fallback) : line))
    .join('');
}

function usualLineEnding(content: string): string {
  const crlf = content.split('\r\n').length - 1;
  const lf = content.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** A few numbered lines around an edit, so the model can check the result without a re-read. */
function snippet(content: string, startLine: number, changedLines: number): string {
  const lines = content.split(/\r?\n/);
  const from = Math.max(1, startLine - 2);
  const to = Math.min(lines.length, startLine + changedLines + 1, from + 20);
  const shown: string[] = [];
  for (let line = from; line <= to; line++) {
    shown.push(`${String(line).padStart(6)}\t${lines[line - 1] ?? ''}`);
  }
  return shown.join('\n');
}

export const listDir = defineTool({
  name: 'list_dir',
  description:
    'List the files and folders in a directory (not recursive). Folders end with "/". ' +
    'Hidden files are included.',
  kind: 'read',
  subjectType: 'path',
  parameters: z.object({ path: pathParam.default('.') }),
  subject: (args) => args.path,
  async run({ path }, { workspace }) {
    const shown = workspace.displayPath(path);
    const info = await workspace.stat(path);
    if (!info) throw new Error(`${shown} does not exist.`);
    if (!info.isDirectory) throw new Error(`${shown} is a file, not a directory.`);

    const entries = (await workspace.list(path))
      .map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name))
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
    if (!entries.length) return `${shown} is empty.`;
    const more = entries.length - MAX_ENTRIES;
    return [
      ...entries.slice(0, MAX_ENTRIES),
      ...(more > 0 ? [`[${more} more entries not shown]`] : []),
    ].join('\n');
  },
});

export const glob = defineTool({
  name: 'glob',
  description:
    'Find files by name pattern, e.g. "**/*.ts" or "src/**/test_*.py". A pattern without "/" ' +
    'matches file names at any depth ("*.md" finds every Markdown file). Respects .gitignore ' +
    'and skips hidden files unless the pattern or path names one (".github/**").',
  kind: 'read',
  subjectType: 'path',
  parameters: z.object({
    pattern: z.string().describe('Glob pattern'),
    path: pathParam.default('.').describe('Directory to search in (default: working directory)'),
  }),
  subject: (args) => args.path,
  async run({ pattern, path }, { workspace, signal }) {
    const target = searchTarget(path, workspace);
    const result = await workspace.ripgrep(
      [
        '--files',
        '--no-config',
        '--sort',
        'path',
        '--path-separator',
        '/',
        ...hiddenFlags(pattern, path),
        '--glob',
        pattern,
        ...target,
      ],
      { signal },
    );
    if (result.exitCode === 1 || (result.exitCode === 0 && !result.stdout.trim())) {
      return `No files match ${pattern}.`;
    }
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'ripgrep failed.');
    return limitLines(result.stdout, MAX_ENTRIES, 'files');
  },
});

export const grep = defineTool({
  name: 'grep',
  description:
    'Search file contents with a regular expression (ripgrep syntax). Returns matching file ' +
    'paths by default, or matching lines with line numbers when output is "content". ' +
    'Respects .gitignore and skips hidden files unless the glob or path names one.',
  kind: 'read',
  subjectType: 'path',
  parameters: z.object({
    pattern: z.string().describe('Regular expression to search for'),
    path: pathParam
      .default('.')
      .describe('File or directory to search (default: working directory)'),
    glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts"'),
    ignore_case: z.boolean().optional(),
    output: z.enum(['files', 'content']).default('files'),
    context: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Lines of context around matches (content output only)'),
  }),
  subject: (args) => args.path,
  async run(args, { workspace, signal }) {
    const flags = [
      '--no-config',
      '--color',
      'never',
      '--path-separator',
      '/',
      '--max-columns',
      '400',
      '--max-columns-preview',
    ];
    if (args.ignore_case) flags.push('--ignore-case');
    flags.push(...hiddenFlags(args.glob, args.path));
    if (args.glob) flags.push('--glob', args.glob);
    if (args.output === 'files') flags.push('--files-with-matches', '--sort', 'path');
    else
      flags.push(
        '--line-number',
        '--no-heading',
        ...(args.context ? ['--context', String(args.context)] : []),
      );

    const result = await workspace.ripgrep(
      [...flags, '--regexp', args.pattern, ...searchTarget(args.path, workspace)],
      { signal },
    );
    if (result.exitCode === 1) return 'No matches.';
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'ripgrep failed.');
    return limitLines(result.stdout, MAX_GREP_LINES, args.output === 'files' ? 'files' : 'lines');
  },
});

/**
 * ripgrep skips hidden files, so `.heaw/**` or `.github/workflows/*.yml` would find nothing and
 * the agent would think there are none. A pattern or path that names a hidden folder or file
 * searches hidden ones too. (`.git` stays out unless named.)
 */
function hiddenFlags(...patterns: Array<string | undefined>): string[] {
  const namesHidden = patterns.some(
    (pattern) => pattern !== undefined && /(?:^|[\\/])\.(?!\.?(?:[\\/]|$))/.test(pattern),
  );
  return namesHidden ? ['--hidden', '--glob', '!.git/'] : [];
}

/** ripgrep prefixes results with the path argument, so the root is searched without one. */
function searchTarget(path: string, workspace: ToolContext['workspace']): string[] {
  workspace.resolve(path);
  const shown = workspace.displayPath(path);
  return shown === '.' ? [] : ['--', shown];
}

function limitLines(text: string, max: number, noun: string): string {
  const lines = text.trimEnd().split('\n');
  if (lines.length <= max) return lines.join('\n');
  return `${lines.slice(0, max).join('\n')}\n[${lines.length - max} more ${noun} not shown; narrow the search]`;
}

export const FS_TOOLS = [readFile, writeFile, editFile, listDir, glob, grep];
