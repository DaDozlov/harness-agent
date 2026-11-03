import { z } from 'zod';
import { defineTool } from './define.js';

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;

export const runCommand = defineTool({
  name: 'run_command',
  description:
    'Run a shell command and return its output (stdout and stderr together) and exit code. ' +
    'The shell is named in the environment block. Commands cannot read input, so avoid ' +
    'interactive commands (use flags like --yes). Commands that never exit, such as dev ' +
    `servers, are stopped at the timeout (default ${DEFAULT_TIMEOUT_SECONDS} s). Prefer ` +
    'read_file, glob and grep over cat, find and grep commands.',
  kind: 'execute',
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
  }),
  subject: (args) => args.command,
  async run({ command, cwd, timeout_seconds = DEFAULT_TIMEOUT_SECONDS }, { workspace, signal }) {
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

export const SHELL_TOOLS = [runCommand];
