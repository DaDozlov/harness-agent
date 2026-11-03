import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommand, type RunContext, runPrompt } from '../../src/cli/commands/run.js';
import { ModelError } from '../../src/core/errors.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';

function output() {
  let text = '';
  return {
    write: (chunk: string) => (text += chunk),
    get text() {
      return text;
    },
  };
}

async function scriptedEngine(responses: ScriptedResponse[]) {
  const model = new ScriptedModelClient(responses);
  return { model, engine: await createEngine({ model }) };
}

/** An empty project and an empty HEAW_HOME, so no real config on this machine is read. */
const SANDBOX = mkdtempSync(join(tmpdir(), 'heaw-run-'));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

function context(overrides: Partial<RunContext> = {}) {
  const stdout = output();
  const stderr = output();
  const ctx: RunContext = {
    cwd: SANDBOX,
    stdout,
    stderr,
    readStdin: () => Promise.resolve(undefined),
    createEngine,
    ...overrides,
    env: { HEAW_HOME: join(SANDBOX, 'home'), ...overrides.env },
  };
  return { ctx, stdout, stderr };
}

describe('runPrompt', () => {
  it('prints the answer to stdout and a summary to stderr', async () => {
    const { engine } = await scriptedEngine([
      { text: 'Hello!', usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const stdout = output();
    const stderr = output();

    const code = await runPrompt(engine, 'Hi', {}, { stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.text).toBe('Hello!\n');
    expect(stderr.text).toBe('scripted:test · 1 turn · 3 in / 2 out tokens\n');
  });

  it('prints events as JSON lines with --json', async () => {
    const { engine } = await scriptedEngine([{ text: 'Hello!' }]);
    const stdout = output();

    await runPrompt(engine, 'Hi', { json: true }, { stdout, stderr: output() });

    const events = stdout.text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(events[0]?.type).toBe('run.start');
    expect(events.at(-1)?.type).toBe('run.end');
  });

  it('reports errors and exits with 1', async () => {
    const { engine } = await scriptedEngine([
      { error: new ModelError('Invalid API key', { retryable: false, status: 401 }) },
    ]);
    const stderr = output();

    const code = await runPrompt(engine, 'Hi', {}, { stdout: output(), stderr });

    expect(code).toBe(1);
    expect(stderr.text).toContain('Error (401): Invalid API key');
  });
});

describe('runCommand', () => {
  it('asks for a model when none is set', async () => {
    const { ctx, stderr } = context();

    const code = await runCommand(['Hi'], {}, ctx);

    expect(code).toBe(2);
    expect(stderr.text).toContain('HEAW_MODEL');
  });

  it('explains missing credentials without a stack trace', async () => {
    const { ctx, stderr } = context();

    const code = await runCommand(['Hi'], { model: 'azure:my-deployment' }, ctx);

    expect(code).toBe(2);
    expect(stderr.text).toBe(
      'Azure OpenAI needs an API key. Set AZURE_OPENAI_API_KEY in your environment or in a .env file.\n',
    );
  });

  it('asks for a prompt when there is none', async () => {
    const { ctx, stderr } = context({ env: { HEAW_MODEL: 'azure:dep' } });

    expect(await runCommand([], {}, ctx)).toBe(2);
    expect(stderr.text).toContain('Provide a prompt');
  });

  it('reads the prompt from stdin and the model from HEAW_MODEL', async () => {
    const { model, engine } = await scriptedEngine([{ text: 'Piped!' }]);
    const requestedModels: unknown[] = [];
    const { ctx, stdout } = context({
      env: { HEAW_MODEL: 'scripted:test' },
      readStdin: () => Promise.resolve('Hello from a pipe\n'),
      createEngine: (options) => {
        requestedModels.push(options.model);
        return Promise.resolve(engine);
      },
    });

    const code = await runCommand([], {}, ctx);

    expect(code).toBe(0);
    expect(requestedModels).toEqual(['scripted:test']);
    expect(model.requests[0]?.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Hello from a pipe' }],
    });
    expect(stdout.text).toBe('Piped!\n');
  });

  it('disposes the workspace it set up, so a Docker container does not outlive the run', async () => {
    let disposed = false;
    const { ctx } = context({
      env: { HEAW_MODEL: 'scripted:test' },
      createEngine: (options) => {
        const workspace = options.workspace!;
        const dispose = workspace.dispose.bind(workspace);
        workspace.dispose = () => {
          disposed = true;
          return dispose();
        };
        return createEngine({ ...options, model: new ScriptedModelClient([{ text: 'ok' }]) });
      },
    });

    expect(await runCommand(['hi'], {}, ctx)).toBe(0);
    expect(disposed).toBe(true);
  });
});
