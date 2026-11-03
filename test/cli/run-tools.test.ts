import { describe, expect, it } from 'vitest';
import { runCommand, type RunContext, runPrompt } from '../../src/cli/commands/run.js';
import { createEngine, type EngineOptions } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { defineTool } from '../../src/tools/define.js';
import { z } from 'zod';
import { tempDirFactory, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();
const tempDir = tempDirFactory();

function output() {
  let text = '';
  return {
    write: (chunk: string) => (text += chunk),
    get text() {
      return text;
    },
  };
}

describe('heaw run with tools', () => {
  it('passes permission flags on and never asks for approval', async () => {
    const received: EngineOptions[] = [];
    const engine = await createEngine({ model: new ScriptedModelClient([{ text: 'ok' }]) });
    const sandbox = await tempDir();
    const context: RunContext = {
      cwd: sandbox,
      env: { HEAW_MODEL: 'scripted:test', HEAW_HOME: sandbox },
      stdout: output(),
      stderr: output(),
      readStdin: () => Promise.resolve(undefined),
      createEngine: (options) => {
        received.push(options);
        return Promise.resolve(engine);
      },
    };

    await runCommand(
      ['Hi'],
      { mode: 'accept-edits', allow: ['run_command(npm test*)'], deny: ['read_file(.env)'] },
      context,
    );

    expect(received[0]).toMatchObject({
      interactive: false,
      permissions: {
        mode: 'accept-edits',
        preapproved: ['run_command(npm test*)'],
        deny: ['read_file(.env)'],
      },
    });
    expect(received[0]).not.toHaveProperty('toolsets');
  });

  it('reports an invalid rule without a stack trace', async () => {
    const stderr = output();
    const sandbox = await tempDir();
    const context: RunContext = {
      cwd: sandbox,
      env: {
        HEAW_HOME: sandbox,
        HEAW_MODEL: 'azure:x',
        AZURE_OPENAI_API_KEY: 'k',
        AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com',
      },
      stdout: output(),
      stderr,
      readStdin: () => Promise.resolve(undefined),
      createEngine,
    };

    expect(await runCommand(['Hi'], { allow: ['run_command('] }, context)).toBe(2);
    expect(stderr.text).toMatch(/^Invalid permission rule "run_command\("/);
  });

  it('shows tool activity on stderr, on its own line after streamed text', async () => {
    const workspace = await tempWorkspace();
    await workspace.writeFile('a.txt', 'hello');
    const model = new ScriptedModelClient([
      {
        text: 'Let me look.',
        toolCalls: [
          { name: 'read_file', args: { path: 'a.txt' } },
          { name: 'write_file', args: { path: 'b.txt', content: 'x' } },
        ],
      },
      { text: 'Done.' },
    ]);
    const engine = await createEngine({ model, workspace, interactive: false });
    const stdout = output();
    const stderr = output();

    await runPrompt(engine, 'Go', {}, { stdout, stderr });

    expect(stdout.text).toBe('Let me look.\nDone.\n');
    // Permission decisions come before execution, so the denial is reported first.
    expect(stderr.text).toMatch(
      /^\[denied\] write_file b\.txt\n {2}Permission denied: .*"write_file\(b\.txt\)"\.\n\[tool\] read_file a\.txt\nscripted:test · 2 turns/,
    );
    // The model still gets the results in the order it made the calls.
    expect(
      model.requests[1]?.messages
        .at(-1)
        ?.content.map((part) => part.type === 'tool-result' && part.name),
    ).toEqual(['read_file', 'write_file']);
  });

  it('summarizes a failed command by its status line, not its first line', async () => {
    const npmTest = defineTool({
      name: 'run_command',
      description: 'fake',
      kind: 'read',
      parameters: z.object({ command: z.string() }),
      run: () => ({ output: '> test\n> node --test\n\nfail 1\n\n[exit code 1]', isError: true }),
    });
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: 'run_command', args: { command: 'npm test' } }] },
      { text: 'Tests fail.' },
    ]);
    const engine = await createEngine({ model, toolsets: [], tools: [npmTest] });
    const stderr = output();

    await runPrompt(engine, 'Go', {}, { stdout: output(), stderr });

    expect(stderr.text).toMatch(/^\[failed\] run_command npm test\n {2}\[exit code 1\]\n/);
  });
});
