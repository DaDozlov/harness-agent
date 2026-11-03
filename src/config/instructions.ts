import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstructionFile } from '../core/instructions.js';

/** Longer files are cut; instructions compete with the conversation for the context window. */
const MAX_CHARS = 20_000;

/**
 * Personal (`~/.heaw/AGENTS.md`) and project (`AGENTS.md`) instructions, most general first
 * (docs/DESIGN.md §4.6). AGENTS.md is a shared convention, so the same file serves other agents.
 */
export async function loadInstructions(options: {
  projectRoot: string;
  heawHome: string;
}): Promise<InstructionFile[]> {
  const candidates = [
    { path: join(options.heawHome, 'AGENTS.md'), source: '~/.heaw/AGENTS.md' },
    { path: join(options.projectRoot, 'AGENTS.md'), source: 'AGENTS.md' },
  ];
  const files: InstructionFile[] = [];
  for (const { path, source } of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const text = cleanInstructions(raw);
    if (text) files.push({ source, text });
  }
  return files;
}

/**
 * Drops HTML comments (template hints are not instructions) and returns nothing for a file that
 * has only headings left, such as an untouched `heaw init` template.
 */
export function cleanInstructions(raw: string): string {
  const text = raw
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const hasContent = text.split('\n').some((line) => line.trim() && !/^#{1,6}\s/.test(line.trim()));
  if (!hasContent) return '';
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n\n[The rest of this file was cut: it is longer than ${MAX_CHARS} characters.]`
    : text;
}
