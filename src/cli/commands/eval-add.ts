import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { stringify } from 'yaml';
import { findProjectRoot } from '../../config/project.js';
import { textOf } from '../../core/messages.js';
import {
  type SessionHeader,
  SessionNotFoundError,
  type SessionRecord,
} from '../../core/session-store.js';
import { JsonlSessionStore } from '../../sessions/jsonl-store.js';
import type { Output } from './run.js';

export interface EvalAddOptions {
  /** The session to turn into a case, by id or a unique prefix. */
  fromSession: string;
  /** `command` checks, e.g. `npm test`. */
  check?: string[];
  /** `judge` checks. */
  judge?: string[];
  trials?: number;
}

/**
 * `heaw eval add <name> --from-session <id>`: turns a session where the agent went wrong into a
 * regression case (docs/evals.md), so the fix to the harness can be shown to work and to keep
 * working. The case starts from the commit the session started from, with its first message.
 */
export async function evalAddCommand(
  name: string,
  options: EvalAddOptions,
  context: { cwd: string; stdout: Output; stderr: Output },
): Promise<number> {
  const fail = (message: string) => {
    context.stderr.write(`${message}\n`);
    return 2;
  };
  if (!/^[\w-]+$/.test(name)) return fail('Use letters, digits, - and _ in the case name.');
  const root = findProjectRoot(context.cwd);
  const file = join(root, 'evals', `${name}.yaml`);
  const shown = relative(context.cwd, file) || file;
  if (existsSync(file)) return fail(`${shown} already exists.`);

  let id: string;
  let records: SessionRecord[];
  try {
    const store = new JsonlSessionStore(root);
    id = await store.resolve(options.fromSession);
    records = await store.load(id);
  } catch (error) {
    if (error instanceof SessionNotFoundError) return fail(error.message);
    throw error;
  }
  const header = records.find((record): record is SessionHeader => record.type === 'session');
  const head = header?.git?.head;
  if (!head) {
    return fail(
      `Session ${id} has no recorded commit: it did not run in a git repository with commits, ` +
        'or an older heaw saved it. Write the case by hand instead (docs/evals.md).',
    );
  }
  const first = records.find(
    (record) => record.type === 'message' && record.message.role === 'user',
  );
  const prompt = first?.type === 'message' ? textOf(first.message).trim() : '';
  if (!prompt) return fail(`Session ${id} has no message to replay.`);

  const checks = [
    ...(options.check ?? []).map((command) => ({ command, expectExitCode: 0 })),
    ...(options.judge ?? []).map((judge) => ({ judge })),
  ];
  const body = stringify(
    {
      description: `From session ${id}: what went wrong, and what a correct result looks like.`,
      checkout: head,
      prompt,
      trials: options.trials ?? 3,
      checks: checks.length ? checks : null,
    },
    { lineWidth: 100 },
  ).replace(/^checks: null$/m, 'checks:');
  const comments = [
    `# Created by heaw eval add from session ${id} (${header.createdAt.slice(0, 10)}).`,
    "# It starts from the commit the session started from, with the session's first message;",
    '# later messages of that session are not replayed.',
    ...(checks.length
      ? []
      : [
          '# Add checks that tell a correct result from the mistake, e.g.:',
          '#   - command: npm test',
          '#   - judge: The fix keeps the public API unchanged.',
        ]),
  ];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${comments.join('\n')}\n${body}`);

  context.stdout.write(
    [
      `Created ${shown} from session ${id}, starting at commit ${head.slice(0, 7)}.`,
      ...(header.git?.dirty
        ? [
            'The session started with uncommitted changes; the case starts from the last commit, ' +
              'without them. Commit them and edit checkout if the task needs them.',
          ]
        : []),
      checks.length
        ? `Run it: heaw eval ${name}`
        : `Add its checks, then run it: heaw eval ${name}`,
      '',
    ].join('\n'),
  );
  return 0;
}
