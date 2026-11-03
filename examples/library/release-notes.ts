/**
 * A fixed workflow in code: one agent drafts release notes from the commits since the last tag,
 * a second one checks the draft against the commits, and the script writes RELEASE_NOTES.md.
 * Shows a custom tool, agents defined in code, and runAgent.
 *
 *   node --env-file-if-exists=.env release-notes.ts [since-ref]
 */
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  createEngine,
  defineTool,
  type AgentDefinition,
} from 'harness-engineered-agentic-workflow';

// A read-only tool: no approval needed, and the agents need no shell access to use it.
const commits = defineTool({
  name: 'list_commits',
  description: 'Commits in a range, newest first, with their messages and changed files.',
  kind: 'read',
  parameters: z.object({
    since: z.string().describe('A tag, branch or commit; the range is since..HEAD'),
  }),
  async run({ since }, { workspace }) {
    if (!/^[\w./~^-]+$/.test(since)) throw new Error(`Not a git ref: ${since}`);
    const log = await workspace.exec(`git log --stat --format="--- %h %s%n%b" ${since}..HEAD`);
    if (log.exitCode !== 0) throw new Error(log.output);
    return log.output || 'No commits in that range.';
  },
});

const agents: AgentDefinition[] = [
  {
    name: 'writer',
    description: 'Drafts release notes from commits.',
    prompt:
      'You write release notes for users of the project, not its developers. Group changes ' +
      'under Added, Changed, Fixed and Removed; leave out internal refactoring, tests and CI. ' +
      'One line per change, in plain words. Answer with the Markdown only.',
    tools: ['list_commits', 'read_file', 'grep'],
    mode: 'read-only',
    source: 'release-notes.ts',
  },
  {
    name: 'checker',
    description: 'Checks release notes against the commits.',
    prompt:
      'You get release notes and the range they cover. Compare them with the commits: fix ' +
      'anything wrong, missing or internal, keep the format. Answer with the corrected ' +
      'Markdown only.',
    tools: ['list_commits'],
    mode: 'read-only',
    source: 'release-notes.ts',
  },
];

const since = process.argv[2] ?? (await latestTag());
const engine = await createEngine({
  model: process.env.HEAW_MODEL ?? 'azure:gpt-5.4',
  tools: [commits],
  agents,
  limits: { maxTurns: 20, maxCostUsd: 1 },
});

try {
  const draft = await engine.runAgent('writer', `Release notes for the commits since ${since}.`);
  const checked = await engine.runAgent(
    'checker',
    `Range: ${since}..HEAD\n\nRelease notes:\n${draft.text}`,
  );
  await writeFile('RELEASE_NOTES.md', `${checked.text.trim()}\n`);

  // Costs are known when the model's prices are.
  const total =
    draft.costUsd === undefined || checked.costUsd === undefined
      ? ''
      : ` for $${(draft.costUsd + checked.costUsd).toFixed(3)}`;
  console.log(`Wrote RELEASE_NOTES.md (since ${since})${total}.`);
} finally {
  await engine.dispose();
  await engine.workspace.dispose();
}

async function latestTag(): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('git', ['describe', '--tags', '--abbrev=0']);
    return stdout.trim();
  } catch {
    return 'HEAD~20'; // no tags yet
  }
}
