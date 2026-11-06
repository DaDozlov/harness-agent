import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSlashCommand, SETUP_PROMPT, type CommandContext } from '../src/cli/chat/commands.js';
import { reloadChat, SetupWatcher } from '../src/cli/chat/reload.js';
import { createEngine } from '../src/engine.js';
import { inspectProject, loadProject } from '../src/project.js';
import { ScriptedModelClient } from '../src/providers/scripted.js';
import { JsonlSessionStore } from '../src/sessions/jsonl-store.js';
import { LocalWorkspace } from '../src/workspace/local.js';
import { collect, tempDirFactory } from './helpers.js';

const tempDir = tempDirFactory();
const PACKAGE_ENTRY = resolve('src/index.ts');

async function project(config: string, files: Record<string, string> = {}) {
  const root = await tempDir();
  await writeFile(join(root, 'heaw.config.ts'), config);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const options = (root: string, env: Record<string, string> = {}) => ({
  cwd: root,
  env: { HEAW_HOME: join(root, 'home'), ...env },
  packageEntry: PACKAGE_ENTRY,
});

describe('the setup-harness skill', () => {
  it('comes with every project, and a project skill of the same name replaces it', async () => {
    const plain = await project("export default { model: 'ollama:test' };");
    const own = await project("export default { model: 'ollama:test' };", {
      '.heaw/skills/setup-harness/SKILL.md':
        '---\nname: setup-harness\ndescription: Our own setup.\n---\nDo it our way.',
    });

    const builtIn = (await loadProject(options(plain))).options.skills ?? [];
    const replaced = (await loadProject(options(own))).options.skills ?? [];

    expect(builtIn.map((skill) => [skill.name, skill.shownDir])).toEqual([
      ['setup-harness', 'built into heaw'],
      ['plan-work', 'built into heaw'],
      ['retro', 'built into heaw'],
    ]);
    expect(replaced.map((skill) => [skill.name, skill.description])).toEqual([
      ['plan-work', expect.stringContaining('plan a task')],
      ['retro', expect.stringContaining('/retro')],
      ['setup-harness', 'Our own setup.'],
    ]);
  });

  it('loads with its instructions, which point to check_config', async () => {
    const root = await project("export default { model: 'ollama:test' };");
    const setup = await loadProject(options(root));
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: 'load_skill', args: { name: 'setup-harness' } }] },
      { text: 'Loaded.' },
    ]);
    const engine = await createEngine({ ...setup.options, model, mcp: undefined });

    await collect(engine.session().send(SETUP_PROMPT));
    await engine.dispose();
    await engine.workspace.dispose();

    expect(model.requests[0]?.system).toContain(
      '- setup-harness: Use when the user asks to set up',
    );
    expect(model.requests[0]?.tools?.map((tool) => tool.name)).toContain('check_config');
    const loaded = JSON.stringify(model.requests[1]?.messages.at(-1));
    expect(loaded).toContain('# Skill: setup-harness');
    expect(loaded).toContain('check_config');
    expect(loaded).toContain('heaw applies the changed setup by itself');
  });
});

describe('check_config', () => {
  it('summarizes a configuration that loads', async () => {
    const root = await project(
      [
        "import { defineConfig } from 'harness-engineered-agentic-workflow';",
        'export default defineConfig({',
        "  model: 'ollama:test',",
        "  permissions: { mode: 'accept-edits', allow: ['run_command(npm test*)'] },",
        '  limits: { maxTurns: 40 },',
        '  hooks: { beforeStop: () => undefined },',
        '});',
      ].join('\n'),
      { 'AGENTS.md': '# App\n\nA small app.' },
    );

    const report = await inspectProject(options(root));

    expect(report).toContain('The configuration loads.');
    expect(report).toContain('- Model: ollama:test (price unknown');
    expect(report).toContain('- Permissions: accept-edits mode; allow run_command(npm test*)');
    expect(report).toContain('- Limits: maxTurns 40');
    expect(report).toContain('- Checks before finishing: hooks beforeStop');
    expect(report).toContain('- Instructions: AGENTS.md');
    expect(report).toContain('The chat applies it before the next message');
  });

  it('reports what stops a configuration from loading', async () => {
    const cases = {
      setting: "export default { model: 'ollama:test', permissions: { mode: 'yolo' } };",
      rule: "export default { model: 'ollama:test', permissions: { allow: ['bad rule('] } };",
      credentials: "export default { model: 'openai:gpt-5' };",
      price: "export default { model: 'ollama:test', limits: { maxCostUsd: 2 } };",
      syntax: 'export default { model: ',
    };
    const reports: Record<string, string> = {};
    for (const [name, config] of Object.entries(cases)) {
      reports[name] = await inspectProject(options(await project(config)));
    }

    for (const report of Object.values(reports)) {
      expect(report).toMatch(/^The configuration does not load/);
    }
    expect(reports.setting).toContain('mode');
    expect(reports.rule).toContain('Invalid permission rule');
    expect(reports.credentials).toContain('OPENAI_API_KEY');
    expect(reports.price).toContain('price');
  });
});

describe('/reload and /setup', () => {
  it('continues the conversation in an engine built from the changed config', async () => {
    const root = await project("export default { model: 'ollama:test' };");
    const store = new JsonlSessionStore(root);
    const first = await createEngine({
      model: new ScriptedModelClient([{ text: 'Hello.' }]),
      workspace: new LocalWorkspace(root),
      toolsets: [],
      sessionStore: store,
    });
    const session = first.session();
    await collect(session.send('Hi'));
    let disposed = false;
    const dispose = first.dispose.bind(first);
    first.dispose = async () => {
      disposed = true;
      await dispose();
    };

    const second = await createEngine({
      model: new ScriptedModelClient([{ text: 'Still here.' }]),
      workspace: new LocalWorkspace(root),
      toolsets: [],
      sessionStore: store,
      permissions: { mode: 'accept-edits' },
    });
    const result = await reloadChat({ engine: first, session }, () =>
      Promise.resolve({ engine: second, warnings: ['skills/x: no description'] }),
    );
    await collect(result.session.send('Are you there?'));
    await second.dispose();

    expect(disposed).toBe(true);
    expect(result.session.id).toBe(session.id);
    expect(result.session.permissions.mode).toBe('accept-edits');
    expect(result.session.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(result.text).toContain('Warning: skills/x: no description');
    expect(result.text).toMatch(/^Reloaded: \S+, accept-edits mode, 0 tools/m);
    // One log, continued.
    expect((await store.list()).map((summary) => [summary.id, summary.runs])).toEqual([
      [session.id, 2],
    ]);
  });

  it('/setup asks the agent to run the skill, /reload reports what it applied', async () => {
    const sent: string[] = [];
    const printed: string[] = [];
    const context = {
      print: (text: string) => printed.push(text),
      refresh: () => undefined,
      send: (text: string) => sent.push(text),
      reload: () => Promise.resolve('Reloaded: ollama:test'),
    } as unknown as CommandContext;

    await runSlashCommand('/setup', context);
    await runSlashCommand('/setup it is a CLI', context);
    await runSlashCommand('/reload', context);

    expect(sent).toEqual([SETUP_PROMPT, `${SETUP_PROMPT} Notes: it is a CLI`]);
    expect(printed).toEqual(['Reloading the setup…', 'Reloaded: ollama:test']);
  });
});

describe('applying a changed setup', () => {
  it('notices changed, added and removed setup files, until they are accepted', async () => {
    const root = await project("export default { model: 'ollama:test' };", {
      'AGENTS.md': '# App',
      '.heaw/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploys.\n---\nGo.',
    });
    const watcher = await SetupWatcher.start(root);
    expect(await watcher.changes()).toEqual([]);

    await writeFile(join(root, 'heaw.config.ts'), "export default { model: 'ollama:other' };");
    await writeFile(join(root, '.mcp.json'), '{}');
    await rm(join(root, '.heaw/skills/deploy/SKILL.md'));
    await writeFile(join(root, 'src.ts'), 'not part of the setup');

    expect(await watcher.changes()).toEqual([
      '.heaw/skills/deploy/SKILL.md',
      '.mcp.json',
      'heaw.config.ts',
    ]);
    await watcher.accept();
    expect(await watcher.changes()).toEqual([]);
  });

  it('keeps plan mode and a plan build, and says which background commands stopped', async () => {
    const root = await project("export default { model: 'ollama:test' };");
    const first = await createEngine({
      model: new ScriptedModelClient([]),
      workspace: new LocalWorkspace(root),
      toolsets: ['shell'],
      git: false,
    });
    const building = first.session();
    building.buildPlan();
    const server = 'node -e "setInterval(() => {}, 1000)"';
    await first.callTool(
      'run_command',
      { command: server, background: true },
      {
        allow: ['run_command'],
      },
    );
    const second = await createEngine({
      model: new ScriptedModelClient([{ text: 'ok' }]),
      workspace: new LocalWorkspace(root),
      toolsets: [],
      git: false,
    });

    const result = await reloadChat({ engine: first, session: building }, () =>
      Promise.resolve({ engine: second, warnings: [] }),
    );
    const planning = second.session();
    planning.enterPlanMode();
    const third = second.session();
    third.continuePlan(planning);
    const stillBuilding = result.session.buildingPlan;
    await collect(result.session.send('Go on'));
    await second.dispose();

    expect(stillBuilding).toBe(true);
    expect(third.inPlanMode).toBe(true);
    expect(result.text).toContain(`Stopped background commands: ${server}.`);
    expect(JSON.stringify(result.session.messages[0])).toContain(
      'heaw reloaded its setup, which stopped your background commands',
    );
  });
});
