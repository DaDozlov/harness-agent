import { z } from 'zod';
import { commandOutput, startInBackground, stopCommand } from './background.js';
import { defineTool } from './define.js';

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
/**
 * Command output the model sees: builds and test runs print far more than it needs, and what
 * matters (errors, the summary) is usually at the end. The full output is saved to page through.
 */
const COMMAND_OUTPUT = { maxChars: 12_000, headShare: 0.25 };

export const runCommand = defineTool({
  name: 'run_command',
  description:
    'Run a shell command and return its output (stdout and stderr together) and exit code. ' +
    'The shell is named in the environment block. Commands cannot read input, so avoid ' +
    'interactive commands (use flags like --yes). For commands that keep running, such as dev ' +
    'servers and watchers, set background: true (not nohup or &): it returns at once with an ' +
    'id for command_output and stop_command, and heaw stops it when it exits. Other commands ' +
    `are stopped at the timeout (default ${DEFAULT_TIMEOUT_SECONDS} s). Prefer read_file, glob ` +
    'and grep over cat, find and grep commands.',
  kind: 'execute',
  output: COMMAND_OUTPUT,
  parameters: z.object({
    command: z.string().describe('The command to run'),
    cwd: z.string().optional().describe('Directory to run in (default: working directory)'),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_SECONDS)
      .optional()
      .describe(`Stop the command after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS})`),
    background: z
      .boolean()
      .optional()
      .describe('Keep it running in the background, e.g. a server; no timeout'),
  }),
  subject: (args) => args.command,
  async run(
    { command, cwd, timeout_seconds = DEFAULT_TIMEOUT_SECONDS, background },
    { workspace, signal },
  ) {
    if (background) return startInBackground(workspace, command, cwd, signal);
    const result = await workspace.exec(command, {
      cwd,
      timeoutMs: timeout_seconds * 1000,
      signal,
    });
    const output = result.output.trimEnd() || '(no output)';
    if (result.timedOut) {
      return {
        output: `${output}\n\n[Stopped: the command did not finish within ${timeout_seconds} s.]`,
        isError: true,
      };
    }
    return {
      output: `${output}\n\n[exit code ${result.exitCode ?? 'unknown'}]`,
      isError: result.exitCode !== 0,
    };
  },
});

export const SHELL_TOOLS = [runCommand, commandOutput, stopCommand];
