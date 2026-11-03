import { defineConfig, env } from 'harness-engineered-agentic-workflow';

/**
 * An agent that implements Jira stories and opens GitHub pull requests. MCP servers are in
 * .mcp.json; the story workflow is the implement-story skill; see README.md for tokens and
 * branch protection.
 */
export default defineConfig({
  model: 'azure:gpt-5.4',

  // Commands run in a container: the agent can install packages and push, but cannot touch the
  // rest of the machine. Pushing uses the token in GH_TOKEN over HTTPS.
  workspace: {
    type: 'docker',
    image: 'node:24',
    network: 'bridge',
    env: { GH_TOKEN: env('GITHUB_TOKEN') },
    git: { tokenEnv: 'GH_TOKEN' },
  },

  permissions: {
    mode: 'accept-edits',
    allow: [
      'run_command(npm *)',
      'run_command(npx *)',
      'run_command(git status*)',
      'run_command(git diff*)',
      'run_command(git log*)',
      'run_command(git switch*)',
      'run_command(git checkout -b*)',
      'run_command(git add*)',
      'run_command(git commit*)',
      // Reading GitHub and Jira needs no approval.
      'mcp__github__get_*',
      'mcp__github__list_*',
      'mcp__github__search_*',
      'mcp__atlassian__get*',
      'mcp__atlassian__search*',
    ],
    // Pushing, opening a pull request and changing Jira are asked about, unless you allow them
    // for the session (or in a script with runAgent's allow option).
    ask: [
      'run_command(git push*)',
      'mcp__github__create_pull_request',
      'mcp__atlassian__transition*',
    ],
    deny: [
      'read_file(**/.env*)',
      'run_command(git push --force*)',
      'run_command(git push -f*)',
      'mcp__github__merge_pull_request',
      'mcp__github__delete_*',
      // Changes go through git here, where the hook below has tested them, not through the API.
      'mcp__github__push_files',
      'mcp__github__create_or_update_file',
    ],
  },

  limits: { maxTurns: 150, maxCostUsd: 5, maxMinutes: 60 },

  hooks: {
    // The agent may only finish a story when the project's checks pass.
    async beforeStop({ workspace, editedFiles }) {
      // A question that changed nothing needs no test run.
      if (!editedFiles.length) return undefined;
      const checks = await workspace.exec('npm test --silent && npm run lint --silent', {
        timeoutMs: 600_000,
      });
      if (checks.exitCode !== 0) {
        return { continue: true, feedback: `The checks fail:\n${checks.output.slice(-4_000)}` };
      }
      return undefined;
    },
  },
});
