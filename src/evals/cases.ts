import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { LoadedDefinitions } from '../agents/definitions.js';
import { PERMISSION_MODES, type PermissionMode } from '../core/permissions.js';

/** One way to tell whether a trial succeeded. */
export type EvalCheck =
  | {
      command: string;
      expectExitCode: number;
      /**
       * A folder copied into the workspace before the command runs, replacing files of the same
       * name: tests the agent never saw, or the originals of files it must not weaken.
       */
      files?: string;
    }
  | { judge: string }
  | { answerContains: string }
  | { file: string; exists: boolean; contains?: string }
  /** The run took at most this many model turns: what a task should cost, not only its result. */
  | { maxTurns: number };

/** An eval case (docs/DESIGN.md §4.16), from `evals/<name>.yaml`. */
export interface EvalCase {
  name: string;
  /** The YAML file it came from. */
  source: string;
  /** A folder copied into a fresh workspace for each trial. Default: an empty workspace. */
  fixture?: string;
  /**
   * Instead of a fixture: a commit (or tag or branch) of the git repository the case file is in,
   * checked out for each trial, e.g. the commit a session started from (`heaw eval add`).
   */
  checkout?: string;
  prompt: string;
  trials: number;
  /** Runs in the workspace before the agent, e.g. `npm ci`. */
  setup?: string;
  /** Default: `bypass` in a Docker workspace, otherwise `accept-edits`. */
  mode?: PermissionMode;
  allow: string[];
  limits: { maxTurns?: number; maxCostUsd?: number; maxMinutes?: number };
  checks: EvalCheck[];
}

const caseSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    fixture: z.string().min(1).optional(),
    checkout: z
      .string()
      .regex(/^[\w./~^-]+$/, 'expected a commit, tag or branch')
      .optional(),
    prompt: z.string().min(1),
    trials: z.number().int().min(1).max(100).default(1),
    setup: z.string().min(1).optional(),
    mode: z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]).optional(),
    allow: z.array(z.string()).default([]),
    limits: z
      .object({
        maxTurns: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
        maxMinutes: z.number().positive().optional(),
      })
      .strict()
      .default({}),
    // An empty `checks:` (as `heaw eval add` writes it) gets the helpful message below.
    checks: z.preprocess(
      (value) => value ?? [],
      z
        .array(
          z.union([
            z
              .object({
                command: z.string().min(1),
                expectExitCode: z.number().int().default(0),
                files: z.string().min(1).optional(),
              })
              .strict(),
            z.object({ judge: z.string().min(1) }).strict(),
            z.object({ answerContains: z.string().min(1) }).strict(),
            z
              .object({
                file: z.string().min(1),
                exists: z.boolean().default(true),
                contains: z.string().optional(),
              })
              .strict(),
            z.object({ maxTurns: z.number().int().positive() }).strict(),
          ]),
        )
        .min(1, 'add at least one check, or nothing can fail'),
    ),
  })
  .strict()
  .refine((data) => !(data.fixture && data.checkout), {
    message: 'use fixture or checkout, not both',
    path: ['checkout'],
  });

/**
 * The cases in `dir` (`evals/` of a project), optionally only those whose name or file name
 * contains `filter`. Unusable files are reported, not fatal.
 */
export async function loadEvalCases(
  dir: string,
  filter?: string,
): Promise<LoadedDefinitions<EvalCase>> {
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((file) => ['.yaml', '.yml'].includes(extname(file)))
      .sort()
      .map((file) => join(dir, file));
  } catch {
    return { items: [], problems: [] };
  }
  const items: EvalCase[] = [];
  const problems: string[] = [];
  for (const file of files) {
    try {
      const evalCase = parseEvalCase(await readFile(file, 'utf8'), file);
      const matches = !filter || evalCase.name.includes(filter) || basename(file).includes(filter);
      if (matches) items.push(evalCase);
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  return { items, problems };
}

export function parseEvalCase(text: string, source: string): EvalCase {
  const result = caseSchema.safeParse(parseYaml(text));
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(case)'}: ${issue.message}`,
    );
    throw new Error(problems.join('; '));
  }
  const data = result.data;
  return {
    name: data.name ?? basename(source, extname(source)),
    source,
    ...(data.fixture && { fixture: resolve(dirname(source), data.fixture) }),
    ...(data.checkout && { checkout: data.checkout }),
    prompt: data.prompt,
    trials: data.trials,
    ...(data.setup && { setup: data.setup }),
    ...(data.mode && { mode: data.mode }),
    allow: data.allow,
    limits: data.limits,
    // Like the fixture, a check's files are named relative to the case file.
    checks: data.checks.map((check) =>
      'command' in check && check.files
        ? { ...check, files: resolve(dirname(source), check.files) }
        : check,
    ),
  };
}
