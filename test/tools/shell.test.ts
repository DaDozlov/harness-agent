import { describe, expect, it } from 'vitest';
import { commandOutput, runningInBackground, stopCommand } from '../../src/tools/background.js';
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

describe('background commands', () => {
  const TICKER = `node -e "let i = 0; setInterval(() => console.log('tick ' + i++), 50)"`;

  it('start, report new output, wait for a text, and stop', async () => {
    const workspace = await tempWorkspace();
    const context = toolContext(workspace);

    const started = await callTool(runCommand, { command: TICKER, background: true }, context);
    expect(started.isError).toBe(false);
    expect(started.output).toMatch(
      /^Started in the background: \[1\] node -e .* \(running for \d+ s\)/,
    );
    expect(runningInBackground(workspace)).toEqual([TICKER]);

    const waited = await callTool(
      commandOutput,
      { id: 1, wait_for: 'tick 80', wait_seconds: 30 },
      context,
    );
    expect(waited.output).toMatch(/^Command: \[1\] .* \(running for \d+ s\)\nNew output:\n/);
    expect(waited.output).toContain('tick 80');
    // Output already reported is not repeated.
    const again = await callTool(commandOutput, { id: 1 }, context);
    expect(again.output).not.toContain('tick 3\n');

    const listed = await callTool(commandOutput, {}, context);
    expect(listed.output).toMatch(/^\[1\] node -e .* \(running for \d+ s\)$/);

    const stopped = await callTool(stopCommand, { id: 1 }, context);
    expect(stopped.output).toMatch(/^Stopped: \[1\] .* \(stopped after \d+ s\)/);
    expect(runningInBackground(workspace)).toEqual([]);
  });

  it('finds a text to wait for that came with the start report already', async () => {
    const context = toolContext(await tempWorkspace());
    await callTool(
      runCommand,
      {
        command: `node -e "console.log('listening'); setInterval(() => {}, 1000)"`,
        background: true,
      },
      context,
    );

    const started = Date.now();
    const waited = await callTool(
      commandOutput,
      { id: 1, wait_for: 'listening', wait_seconds: 20 },
      context,
    );

    expect(waited.output).toMatch(/^Command: \[1\] .* \(running for \d+ s\)\n\(no new output\)$/);
    expect(Date.now() - started).toBeLessThan(2_000);
    await callTool(stopCommand, { id: 1 }, context);
  });

  it('reports a command that ends, and one that is not there', async () => {
    const context = toolContext(await tempWorkspace());

    const started = await callTool(
      runCommand,
      { command: 'node -e "console.log(\'ready\'); process.exit(3)"', background: true },
      context,
    );
    const missing = await callTool(commandOutput, { id: 9 }, context);

    expect(started.output).toMatch(/\(exited with code 3 after \d+ s\)\nNew output:\nready$/);
    expect(missing).toEqual({ output: 'No background command 9.', isError: true });
  });

  it('stop with the workspace, e.g. when heaw exits', async () => {
    const workspace = await tempWorkspace();
    await callTool(runCommand, { command: TICKER, background: true }, toolContext(workspace));

    await workspace.dispose();
    for (let tries = 0; runningInBackground(workspace).length && tries < 50; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(runningInBackground(workspace)).toEqual([]);
  });
});
