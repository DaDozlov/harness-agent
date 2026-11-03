import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanInstructions, loadInstructions } from '../../src/config/instructions.js';
import { loadConfig, mergeConfigs } from '../../src/config/load.js';
import { findProjectRoot } from '../../src/config/project.js';
import { ConfigError, validateConfig } from '../../src/config/schema.js';
import { env } from '../../src/providers/settings.js';
import { tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const PACKAGE_ENTRY = resolve('src/index.ts');

async function files(root: string, entries: Record<string, string>) {
  for (const [path, content] of Object.entries(entries)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function messageOf(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('findProjectRoot', () => {
  it('finds the nearest config or .heaw folder above, else the git root, else the directory', async () => {
    const root = await tempDir();
    await files(root, {
      'repo/.git/HEAD': 'ref: refs/heads/main',
      'repo/packages/app/heaw.config.ts': 'export default {}',
      'repo/packages/app/src/index.ts': '',
      'repo/packages/lib/src/index.ts': '',
      'other/notes.txt': '',
    });
    const home = join(root, 'home');

    expect(findProjectRoot(join(root, 'repo/packages/app/src'), home)).toBe(
      join(root, 'repo/packages/app'),
    );
    expect(findProjectRoot(join(root, 'repo/packages/lib/src'), home)).toBe(join(root, 'repo'));
    expect(findProjectRoot(join(root, 'other'), home)).toBe(join(root, 'other'));
  });

  it('does not treat the personal ~/.heaw folder as a project', async () => {
    const home = await tempDir();
    await files(home, { '.heaw/config.ts': 'export default {}', 'code/app/main.ts': '' });

    expect(findProjectRoot(join(home, 'code/app'), home)).toBe(join(home, 'code/app'));
  });
});

describe('loadConfig', () => {
  it('loads a TypeScript config that imports defineConfig and env from the package', async () => {
    const project = await tempDir();
    await files(project, {
      'heaw.config.ts': [
        "import { defineConfig, env } from 'harness-engineered-agentic-workflow';",
        "const shell: string = 'pwsh';",
        'export default defineConfig({',
        "  model: 'azure:my-deployment',",
        "  providers: { azure: { apiKey: env('MY_KEY'), endpoint: 'https://r.openai.azure.com' } },",
        '  workspace: { shell },',
        "  permissions: { allow: ['run_command(npm test*)'] },",
        '});',
      ].join('\n'),
    });

    const loaded = await loadConfig({
      cwd: project,
      env: { HEAW_HOME: join(project, 'no-home') },
      packageEntry: PACKAGE_ENTRY,
    });

    expect(loaded.projectRoot).toBe(project);
    expect(loaded.files).toEqual([join(project, 'heaw.config.ts')]);
    expect(loaded.config).toMatchObject({
      model: 'azure:my-deployment',
      providers: { azure: { apiKey: env('MY_KEY') } },
      workspace: { shell: 'pwsh' },
    });
  });

  it('combines personal and project settings', async () => {
    const root = await tempDir();
    await files(root, {
      'home/config.ts':
        "export default { model: 'openai:gpt-5', permissions: { mode: 'accept-edits', deny: ['read_file(**/.env*)'] } };",
      'project/heaw.config.ts':
        "export default { model: 'azure:dep', permissions: { allow: ['run_command(npm test*)'] } };",
    });

    const { config, files: loadedFiles } = await loadConfig({
      cwd: join(root, 'project'),
      env: { HEAW_HOME: join(root, 'home') },
    });

    expect(loadedFiles).toHaveLength(2);
    expect(config.model).toBe('azure:dep');
    expect(config.permissions).toEqual({
      mode: 'accept-edits',
      allow: ['run_command(npm test*)'],
      ask: [],
      deny: ['read_file(**/.env*)'],
    });
  });

  it('returns an empty config when there is no config file', async () => {
    const project = await tempDir();

    const loaded = await loadConfig({ cwd: project, env: { HEAW_HOME: join(project, 'none') } });

    expect(loaded).toEqual({ config: {}, files: [], projectRoot: project });
  });

  it('reports a config file that does not load, naming the file', async () => {
    const project = await tempDir();
    await files(project, { 'heaw.config.ts': 'export default {' });

    await expect(
      loadConfig({ cwd: project, env: { HEAW_HOME: join(project, 'none') } }),
    ).rejects.toThrow(`Could not load ${join(project, 'heaw.config.ts')}`);
  });
});

describe('validateConfig', () => {
  it('names each invalid setting and points out settings that arrive later', () => {
    const attempt = () =>
      validateConfig(
        {
          model: 42,
          permissions: { mode: 'yolo' },
          toolsets: ['browser'],
          subagents: { maxDepth: 9 },
          hooks: { beforeStop: 'not a function' },
          colour: 'blue',
        },
        'heaw.config.ts',
      );

    expect(attempt).toThrow(ConfigError);
    const message = messageOf(attempt);
    expect(message).toContain('heaw.config.ts has invalid settings:');
    expect(message).toContain('model:');
    expect(message).toContain('permissions.mode:');
    expect(message).toContain('toolsets.0:');
    expect(message).toContain('subagents.maxDepth:');
    expect(message).toContain('hooks.beforeStop: expected a function');
    expect(message).toContain('colour: unknown setting.');
  });

  it('accepts env() references and rejects other objects as settings', () => {
    expect(validateConfig({ providers: { azure: { apiKey: env('KEY') } } }, 'f')).toBeTruthy();
    expect(
      messageOf(() => validateConfig({ providers: { azure: { apiKey: { name: 'KEY' } } } }, 'f')),
    ).toContain("expected text or env('NAME')");
  });

  it('requires a config object', () => {
    expect(() => validateConfig(undefined, 'heaw.config.ts')).toThrow(
      'must export a config object',
    );
  });
});

describe('mergeConfigs', () => {
  it('lets project values win and combines rules', () => {
    const merged = mergeConfigs(
      {
        model: 'a:1',
        providers: { azure: { api: 'chat' } },
        limits: { maxTurns: 10 },
        permissions: { allow: ['x'] },
      },
      {
        model: 'b:2',
        providers: { lmstudio: { type: 'openai-compatible', baseURL: 'http://x' } },
        permissions: { mode: 'read-only', allow: ['y'] },
      },
    );

    expect(merged).toEqual({
      model: 'b:2',
      providers: {
        azure: { api: 'chat' },
        lmstudio: { type: 'openai-compatible', baseURL: 'http://x' },
      },
      limits: { maxTurns: 10 },
      permissions: { mode: 'read-only', allow: ['x', 'y'], ask: [], deny: [] },
    });
  });
});

describe('instructions', () => {
  it('loads personal then project AGENTS.md, without template comments', async () => {
    const root = await tempDir();
    await files(root, {
      'home/AGENTS.md': 'Answer in British English.',
      'project/AGENTS.md':
        '# AGENTS.md\n\n## Commands\n\n<!-- e.g. npm test -->\n- Test: `npm run check`\n',
    });

    const loaded = await loadInstructions({
      projectRoot: join(root, 'project'),
      heawHome: join(root, 'home'),
    });

    expect(loaded).toEqual([
      { source: '~/.heaw/AGENTS.md', text: 'Answer in British English.' },
      { source: 'AGENTS.md', text: '# AGENTS.md\n\n## Commands\n\n- Test: `npm run check`' },
    ]);
  });

  it('skips an untouched template and cuts very long files', () => {
    expect(cleanInstructions('# AGENTS.md\n\n## Project\n\n<!-- describe it -->\n')).toBe('');
    const long = cleanInstructions(`Rule.\n${'x'.repeat(30_000)}`);
    expect(long.length).toBeLessThan(21_000);
    expect(long).toContain('[The rest of this file was cut');
  });
});
