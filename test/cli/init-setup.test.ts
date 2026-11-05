import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initCommand } from '../../src/cli/commands/init.js';
import { NoModelError, setupEngine, userFacingMessage } from '../../src/cli/setup.js';
import { loadConfig } from '../../src/config/load.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { LocalWorkspace } from '../../src/workspace/local.js';
import { collect, tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const PACKAGE_ENTRY = resolve('src/index.ts');

function output() {
  let text = '';
  return {
    write: (chunk: string) => (text += chunk),
    get text() {
      return text;
    },
  };
}

describe('heaw init', () => {
  it('creates the project files, and a config that loads', async () => {
    const project = await tempDir();
    const stdout = output();

    expect(await initCommand({ model: 'azure:gpt-5.4' }, { cwd: project, env: {}, stdout })).toBe(
      0,
    );

    expect(stdout.text).toContain('created heaw.config.ts');
    expect(stdout.text).toContain('created AGENTS.md');
    expect(stdout.text).toContain('created .env.example');
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe(
      '# Secrets (heaw init)\n.env\n.env.*\n!.env.example\n',
    );

    const { config } = await loadConfig({
      cwd: project,
      env: { HEAW_HOME: join(project, 'none') },
      packageEntry: PACKAGE_ENTRY,
    });
    expect(config).toMatchObject({
      model: 'azure:gpt-5.4',
      permissions: {
        mode: 'default',
        deny: ['read_file(**/.env)', 'read_file(**/.env.!(example))'],
      },
    });
  });

  // Runs npm, which can take a few seconds on a busy machine.
  it('makes the agent pass the tests before finishing, when the project has tests', async () => {
    const project = await tempDir();
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
    );
    const stdout = output();

    await initCommand({ model: 'azure:x' }, { cwd: project, env: {}, stdout });
    const { config } = await loadConfig({
      cwd: project,
      env: { HEAW_HOME: join(project, 'none') },
      packageEntry: PACKAGE_ENTRY,
    });
    const [hooks] = [config.hooks].flat();
    const stop = (editedFiles: string[]) =>
      hooks!.beforeStop!({
        sessionId: 's',
        agentId: 'main',
        model: 'azure:x',
        workspace: new LocalWorkspace(project),
        signal: new AbortController().signal,
        message: { role: 'assistant', content: [] },
        turns: 1,
        editedFiles,
      });

    expect(stdout.text).toContain('the agent must pass "npm test" before it may finish');
    expect(config.permissions?.allow).toEqual(['run_command(npm test*)']);
    expect(await stop([])).toBeUndefined();
    expect(await stop(['src/a.ts'])).toMatchObject({ continue: true });

    // npm init's placeholder script is not a test suite.
    const placeholder = await tempDir();
    await writeFile(
      join(placeholder, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    await initCommand({ model: 'azure:x' }, { cwd: placeholder, env: {}, stdout: output() });
    expect(await readFile(join(placeholder, 'heaw.config.ts'), 'utf8')).toContain('// hooks: {');
  }, 60_000);

  it('never overwrites existing files and only adds missing .gitignore lines', async () => {
    const project = await tempDir();
    await writeFile(join(project, 'AGENTS.md'), 'Our rules.');
    await writeFile(join(project, '.gitignore'), 'node_modules/\n.env');
    const stdout = output();

    await initCommand({}, { cwd: project, env: { HEAW_MODEL: 'openai:gpt-5' }, stdout });
    await initCommand({}, { cwd: project, env: {}, stdout: output() });

    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe('Our rules.');
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.env\n\n# Secrets (heaw init)\n.env.*\n!.env.example\n',
    );
    expect(stdout.text).toContain('kept AGENTS.md (already exists)');
    expect(await readFile(join(project, 'heaw.config.ts'), 'utf8')).toContain(
      "model: 'openai:gpt-5'",
    );
  });

  it('gives the untouched AGENTS.md template no weight in the prompt', async () => {
    const project = await tempDir();
    await initCommand({}, { cwd: project, env: {}, stdout: output() });

    const { options } = await setupEngine(
      { model: 'azure:x' },
      {
        cwd: project,
        env: { HEAW_HOME: join(project, 'none') },
        interactive: true,
        packageEntry: PACKAGE_ENTRY,
      },
    );

    expect(options.instructions).toEqual([]);
  });
});

describe('setupEngine', () => {
  async function project(config: string, extra: Record<string, string> = {}) {
    const root = await tempDir();
    await writeFile(join(root, 'heaw.config.ts'), config);
    for (const [path, content] of Object.entries(extra)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return root;
  }
  const context = (cwd: string, env: Record<string, string> = {}) => ({
    cwd,
    env: { HEAW_HOME: join(cwd, 'no-home'), ...env },
    interactive: false,
    packageEntry: PACKAGE_ENTRY,
  });

  it('takes flags over environment over config, and combines permission rules', async () => {
    const root = await project(
      "export default { model: 'azure:from-config', permissions: { mode: 'read-only', allow: ['run_command(npm test*)'], deny: ['read_file(.env)'] }, limits: { maxTurns: 7, maxCostUsd: 2 } };",
    );

    const fromConfig = await setupEngine({}, context(root));
    const fromEnv = await setupEngine({}, context(root, { HEAW_MODEL: 'azure:from-env' }));
    const fromFlags = await setupEngine(
      {
        model: 'azure:from-flag',
        mode: 'accept-edits',
        allow: ['run_command(npm run lint)'],
        maxTurns: 3,
        maxMinutes: 10,
      },
      context(root, { HEAW_MODEL: 'azure:from-env' }),
    );

    expect(fromConfig.options).toMatchObject({
      model: 'azure:from-config',
      limits: { maxTurns: 7, maxCostUsd: 2 },
    });
    expect(fromEnv.options.model).toBe('azure:from-env');
    expect(fromFlags.options).toMatchObject({
      model: 'azure:from-flag',
      limits: { maxTurns: 3, maxCostUsd: 2, maxMinutes: 10 },
      permissions: {
        mode: 'accept-edits',
        allow: ['run_command(npm test*)'],
        preapproved: ['run_command(npm run lint)'],
        deny: ['read_file(.env)'],
      },
    });
  });

  it('works in the project root from a subfolder, and saves sessions there', async () => {
    const root = await project("export default { model: 'azure:x' };", { 'src/deep/file.ts': '' });

    const { options, loaded } = await setupEngine({}, context(join(root, 'src/deep')));

    expect(loaded.projectRoot).toBe(root);
    expect(options.workspace?.root).toBe(root);
    expect((options.sessionStore as { dir: string } | undefined)?.dir).toBe(
      join(root, '.heaw', 'sessions'),
    );
  });

  it('turns off tools and saving when asked, from flags or config', async () => {
    const root = await project("export default { model: 'azure:x', sessions: { save: false } };");

    const { options } = await setupEngine({ tools: false }, context(root));

    expect(options.toolsets).toEqual([]);
    expect(options.sessionStore).toBeUndefined();
  });

  it('explains a missing model as a problem the user can fix', async () => {
    const root = await tempDir();

    const failure = await setupEngine({}, context(root)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NoModelError);
    expect(userFacingMessage(failure)).toContain(
      'Set model in heaw.config.ts (heaw init creates one)',
    );
    expect(userFacingMessage(new Error('a bug'))).toBeUndefined();
  });

  it('puts project instructions into the system prompt', async () => {
    const root = await project("export default { model: 'azure:x' };", {
      'AGENTS.md': 'Run tests with npm run check.',
    });
    const { options } = await setupEngine({}, context(root));
    const model = new ScriptedModelClient([{ text: 'ok' }]);

    const engine = await createEngine({ ...options, model, toolsets: [], sessionStore: undefined });
    await collect(engine.session().send('Hi'));

    const system = model.requests[0]?.system ?? '';
    expect(system).toContain(
      '<instructions source="AGENTS.md">\nRun tests with npm run check.\n</instructions>',
    );
    expect(system.indexOf('<instructions')).toBeLessThan(system.indexOf('<environment>'));
  });
});
