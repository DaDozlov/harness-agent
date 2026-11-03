import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProjectEngine } from '../src/project.js';
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
