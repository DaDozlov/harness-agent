import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProjectEngine, loadProject } from '../src/project.js';
import { tempDirFactory } from './helpers.js';

const tempDir = tempDirFactory();

describe('createProjectEngine', () => {
  it('sets up the project as heaw does, and its dispose also stops the workspace', async () => {
    const root = await tempDir();
    await writeFile(
      join(root, 'heaw.config.ts'),
      "export default { model: 'ollama:test-model', permissions: { ask: ['write_file'] } };",
    );
    await writeFile(join(root, 'AGENTS.md'), 'Be brief.');
    await mkdir(join(root, '.heaw', 'agents'), { recursive: true });
    await writeFile(
      join(root, '.heaw', 'agents', 'helper.md'),
      '---\nname: helper\ndescription: Helps.\n---\nHelp.',
    );

    const engine = await createProjectEngine({
      cwd: root,
      env: { HEAW_HOME: join(root, 'home') },
      packageEntry: resolve('src/index.ts'),
      allow: ['write_file(notes.txt)'],
      save: false,
    });
    let stopped = false;
    const dispose = engine.workspace.dispose.bind(engine.workspace);
    Object.assign(engine.workspace, {
      dispose: async () => {
        stopped = true;
        await dispose();
      },
    });

    expect(engine.model.id).toBe('ollama:test-model');
    expect(engine.workspace.root).toBe(root);
    expect(engine.sessionStore).toBeUndefined();
    // `allow` is an approval in advance: it covers what the config's ask rule asks about.
    expect((await engine.callTool('write_file', { path: 'notes.txt', content: 'n' })).status).toBe(
      'ok',
    );
    await engine.dispose();
    expect(stopped).toBe(true);
  });
});

describe('an unattended run in bypass mode', () => {
  const load = async (workspace?: string) => {
    const root = await tempDir();
    await writeFile(
      join(root, 'heaw.config.ts'),
      `export default { model: 'ollama:test-model'${workspace ? `, workspace: ${workspace}` : ''} };`,
    );
    const options = {
      cwd: root,
      env: { HEAW_HOME: join(root, 'home') },
      packageEntry: resolve('src/index.ts'),
      save: false,
      mode: 'bypass' as const,
    };
    return { root, unattended: await loadProject({ ...options, interactive: false }), options };
  };

  it('runs its commands in Docker, unless the config chooses the local workspace', async () => {
    const { root, unattended, options } = await load();
    expect(unattended.createWorkspace(root).kind).toBe('docker');
    expect(unattended.warnings.join('\n')).toContain('commands run in a Docker container');

    // Someone is there to answer: the chat warns about bypass instead.
    const chat = await loadProject({ ...options, interactive: true });
    expect(chat.createWorkspace(root).kind).toBe('local');

    const local = await load("{ type: 'local' }");
    expect(local.unattended.createWorkspace(local.root).kind).toBe('local');
    expect(local.unattended.warnings).toEqual([]);
  });
});
