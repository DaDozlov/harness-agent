import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'harness-engineered-agentic-workflow';

/**
 * A coding agent whose work is checked: syntax right after each edit, the tests before it may
 * finish. `heaw eval` measures how well it does on the cases in evals/.
 */
export default defineConfig({
  model: 'azure:gpt-5.4',

  permissions: {
    mode: 'accept-edits',
    allow: [
      'run_command(npm test*)',
      'run_command(node --test*)',
      'run_command(git status*)',
      'run_command(git diff*)',
      'run_command(git log*)',
    ],
    deny: [
      'read_file(**/.env)',
      'read_file(**/.env.!(example))',
      'run_command(git push*)',
      // npm changes the lockfile; nobody edits it by hand.
      'write_file(**/package-lock.json)',
      'edit_file(**/package-lock.json)',
    ],
  },

  limits: { maxTurns: 100, maxCostUsd: 3 },

  hooks: {
    // Syntax errors show up right after the edit, not only when the tests run.
    async afterToolCall({ tool, args, status, workspace }) {
      if ((tool !== 'write_file' && tool !== 'edit_file') || status !== 'ok') return undefined;
      const { path } = args as { path: string };
      if (!/\.(c|m)?js$/.test(path)) return undefined;
      const check = await workspace.exec(`node --check "${path}"`);
      return check.exitCode === 0 ? undefined : { feedback: `Syntax error:\n${check.output}` };
    },

    // The agent may only finish a run that changed files when the tests pass.
    async beforeStop({ workspace, editedFiles }) {
      if (!editedFiles.length) return undefined;
      const tests = await workspace.exec('npm test', { timeoutMs: 300_000 });
      if (tests.exitCode === 0) return undefined;
      return { continue: true, feedback: `The tests fail:\n${tests.output.slice(-4_000)}` };
    },

    // One line per session, to see what the agent costs over time.
    async sessionEnd({ sessionId, model, usage, costUsd, workspace }) {
      const dir = join(workspace.root, '.heaw');
      await mkdir(dir, { recursive: true });
      const tokens = usage.inputTokens + usage.outputTokens;
      const line = [new Date().toISOString(), sessionId, model, tokens, costUsd ?? ''].join(',');
      await appendFile(join(dir, 'usage.csv'), `${line}\n`);
    },
  },
});
