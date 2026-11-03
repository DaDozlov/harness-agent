import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/tools/shell.js';
import { callTool, toolContext, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

describe('run_command', () => {
  it('returns the output and exit code', async () => {
    const context = toolContext(await tempWorkspace());

    const ok = await callTool(runCommand, { command: 'echo hello' }, context);
    const failed = await callTool(runCommand, { command: 'node -e "process.exit(2)"' }, context);

    expect(ok).toEqual({ output: 'hello\n\n[exit code 0]', isError: false });
    expect(failed).toEqual({ output: '(no output)\n\n[exit code 2]', isError: true });
  });

  it('reports a command stopped at its timeout', async () => {
    const context = toolContext(await tempWorkspace());

    const result = await callTool(
      runCommand,
      { command: 'node -e "setTimeout(() => {}, 60000)"', timeout_seconds: 1 },
      context,
    );

    expect(result).toEqual({
      output: '(no output)\n\n[Stopped: the command did not finish within 1 s.]',
      isError: true,
    });
  });

  it('rejects a timeout above the maximum', () => {
    expect(runCommand.parse({ command: 'x', timeout_seconds: 9999 }).ok).toBe(false);
  });
});
