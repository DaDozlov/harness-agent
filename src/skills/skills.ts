import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { type LoadedDefinitions, parseFrontmatter } from '../agents/definitions.js';
import type { Tool } from '../core/tools.js';
import { defineTool } from '../tools/define.js';

/**
 * Instructions for a kind of task, loaded when needed (docs/DESIGN.md §4.8):
 * `<name>/SKILL.md` in one of the SKILL_FOLDERS (project) or `~/.heaw/skills/` (personal), in the
 * common SKILL.md format, with any supporting files next to it.
 */
export interface Skill {
  name: string;
  description: string;
  /** The folder with SKILL.md and its supporting files. */
  dir: string;
  /** How the agent should refer to the folder: relative to the workspace when inside it. */
  shownDir: string;
  /** A skill built into heaw: its instructions, with no folder or files. */
  content?: string;
}

const SKILL_FILE = 'SKILL.md';
const MAX_LISTED_FILES = 50;

/**
 * Where a project (or one of its folders) keeps skills, lowest priority first: Claude Code's
 * folder and the cross-agent `.agents/skills/` (where tools such as Prisma install theirs) work
 * unchanged; `.heaw/skills/` wins when names clash.
 */
export const SKILL_FOLDERS: readonly string[] = [
  '.claude/skills',
  '.agents/skills',
  '.heaw/skills',
];

/** Personal skills first, then the project's, which win by name. */
export async function loadSkills(dirs: {
  projectRoot: string;
  heawHome: string;
}): Promise<LoadedDefinitions<Skill>> {
  const problems: string[] = [];
  const byName = new Map<string, Skill>();
  const roots = [
    join(dirs.heawHome, 'skills'),
    ...SKILL_FOLDERS.map((folder) => join(dirs.projectRoot, folder)),
  ];
  for (const root of roots) {
    const found = await skillsIn(root, dirs.projectRoot);
    for (const skill of found.items) byName.set(skill.name, skill);
    problems.push(...found.problems);
  }
  return { items: [...byName.values()], problems };
}

/** The skills in one skills folder (`<root>/<name>/SKILL.md`). */
export async function skillsIn(
  root: string,
  projectRoot: string,
): Promise<LoadedDefinitions<Skill>> {
  const items: Skill[] = [];
  const problems: string[] = [];
  for (const dir of await subfolders(root)) {
    const file = join(dir, SKILL_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const { data } = parseFrontmatter(text);
      const name = typeof data['name'] === 'string' ? data['name'].trim() : relative(root, dir);
      const description = typeof data['description'] === 'string' ? data['description'].trim() : '';
      if (!description)
        throw new Error('it has no description, so no agent could know when to use it');
      const fromProject = relative(projectRoot, dir);
      const shownDir = fromProject.startsWith('..') || isAbsolute(fromProject) ? dir : fromProject;
      items.push({ name, description, dir, shownDir: shownDir.replaceAll('\\', '/') });
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}; skipped.`);
    }
  }
  return { items, problems };
}

/** The skills section of the system prompt: names and descriptions only. */
export function formatSkillsIndex(skills: readonly Skill[]): string | undefined {
  if (!skills.length) return undefined;
  return [
    "Skills: this project's own instructions for particular kinds of tasks, which take " +
      'precedence over your general habits. When a request falls under a skill below, your ' +
      'first step is load_skill with its name, then do the task as it says. Do not answer from ' +
      'what you guess the skill says.',
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join('\n');
}

/** `load_skill`: a skill's instructions, or one of its supporting files. */
export function loadSkillTool(skills: readonly Skill[]): Tool {
  return defineTool({
    name: 'load_skill',
    description:
      'Load a skill from the skills list: returns its instructions and the files that come ' +
      'with it. Pass `file` to read one of those files.',
    kind: 'read',
    parameters: z.object({
      name: z.string().describe('The skill name, as listed'),
      file: z.string().optional().describe("A file from the skill's list, e.g. reference.md"),
    }),
    async run({ name, file }) {
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) {
        const names = skills.map((candidate) => candidate.name).join(', ') || 'none';
        return { output: `There is no skill named "${name}". Skills: ${names}.`, isError: true };
      }
      if (skill.content !== undefined) {
        if (file !== undefined) return { output: `The skill ${name} has no files.`, isError: true };
        return `# Skill: ${skill.name}\n\n${skill.content.trim()}`;
      }
      if (file !== undefined) return readSkillFile(skill, file);
      const { body } = parseFrontmatter(await readFile(join(skill.dir, SKILL_FILE), 'utf8'));
      const files = (await filesIn(skill.dir)).filter((path) => path !== SKILL_FILE);
      const listing = files.length
        ? `\n\nFiles in this skill, in ${skill.shownDir} (read one with load_skill and file):\n${files
            .map((path) => `- ${path}`)
            .join('\n')}`
        : '';
      return `# Skill: ${skill.name}\n\n${body.trim()}${listing}`;
    },
  });
}

async function readSkillFile(skill: Skill, file: string) {
  const path = resolve(skill.dir, file);
  const inside = relative(skill.dir, path);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    return { output: `"${file}" is not a file of the skill ${skill.name}.`, isError: true };
  }
  try {
    return await readFile(path, 'utf8');
  } catch {
    return { output: `The skill ${skill.name} has no file "${file}".`, isError: true };
  }
}

/** Files under `dir`, relative and with forward slashes, hidden ones left out. */
async function filesIn(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string, depth: number) => {
    if (depth > 3 || files.length >= MAX_LISTED_FILES) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || files.length >= MAX_LISTED_FILES) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) files.push(relative(dir, path).replaceAll('\\', '/'));
    }
  };
  await walk(dir, 0);
  return files;
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}
