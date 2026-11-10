import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentDefinition, parseAgentDefinition } from '../../src/agents/definitions.js';
import type { ModelRequest } from '../../src/core/model.js';
import type { Tool } from '../../src/core/tools.js';
import { createEngine } from '../../src/engine.js';
import {
  expandValue,
  loadMcpServers,
  type McpServerConfig,
  type McpServerEntry,
  readMcpFile,
  removeServerFromFile,
  writeServerToFile,
} from '../../src/mcp/config.js';
import { McpManager } from '../../src/mcp/manager.js';
import { mcpToolName } from '../../src/mcp/tools.js';
import { env } from '../../src/providers/settings.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { JsonlSessionStore } from '../../src/sessions/jsonl-store.js';
import { collect, tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const FIXTURE = resolve('test/fixtures/mcp-test-server.mjs');
const stdioServer = (extra: Partial<McpServerConfig> = {}): McpServerConfig =>
  ({ command: process.execPath, args: [FIXTURE], ...extra }) as McpServerConfig;
const entry = (name: string, config: McpServerConfig): McpServerEntry => ({
  name,
  config,
  source: 'test',
});

const managers: McpManager[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  for (const child of children.splice(0)) child.kill();
});

async function start(entries: McpServerEntry[], environment: Record<string, string> = {}) {
  const manager = new McpManager({
    env: environment,
    cwd: process.cwd(),
    clientInfo: { name: 'test', version: '0' },
  });
  managers.push(manager);
  await manager.load(entries);
  await manager.ready(20_000);
  return manager;
}

function toolNamed(manager: McpManager, name: string): Tool {
  const tool = manager.tools().find((candidate) => candidate.name === name);
  if (!tool)
    throw new Error(
      `no tool ${name}; have ${manager
        .tools()
        .map((t) => t.name)
        .join(', ')}`,
    );
  return tool;
}

async function call(tool: Tool, args: unknown, signal = new AbortController().signal) {
  const output = await tool.run(args, {
    signal,
    callId: 'c',
    state: new Map(),
    workspace: undefined as never,
  });
  return typeof output === 'string' ? { output, isError: false } : { isError: false, ...output };
}

/** Starts the fixture as a Streamable HTTP server on a free port. */
async function httpServer(token?: string): Promise<string> {
  const child = spawn(process.execPath, [FIXTURE, 'http', '0'], {
    env: { ...process.env, ...(token && { REQUIRE_TOKEN: token }) },
  });
  children.push(child);
  const port = await new Promise<string>((done, fail) => {
    child.stdout.on('data', (chunk: Buffer) => {
      const match = /listening (\d+)/.exec(chunk.toString());
      if (match) done(match[1]!);
    });
    child.on('exit', () => fail(new Error('test server exited')));
  });
  return `http://127.0.0.1:${port}/mcp`;
}

describe('MCP config', () => {
  it('reads .mcp.json in the common format, including VS Code style and "streamable-http"', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'a.json'),
      JSON.stringify({
        mcpServers: {
          local: { command: 'npx', args: ['-y', 'some-server'], env: { TOKEN: '${TOKEN}' } },
          remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
        },
      }),
    );
    await writeFile(
      join(dir, 'b.json'),
      JSON.stringify({ servers: { vs: { type: 'http', url: 'https://x.dev/mcp' } } }),
    );

    expect(await readMcpFile(join(dir, 'a.json'))).toEqual([
      {
        name: 'local',
        config: { command: 'npx', args: ['-y', 'some-server'], env: { TOKEN: '${TOKEN}' } },
        source: join(dir, 'a.json'),
      },
      {
        name: 'remote',
        config: { type: 'http', url: 'https://example.com/mcp' },
        source: join(dir, 'a.json'),
      },
    ]);
    expect((await readMcpFile(join(dir, 'b.json')))[0]?.name).toBe('vs');
    expect(await readMcpFile(join(dir, 'missing.json'))).toEqual([]);
  });

  it('explains invalid files and servers', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'broken.json'), '{ "mcpServers": ');
    await writeFile(
      join(dir, 'nocmd.json'),
      JSON.stringify({ mcpServers: { bad: { args: ['x'] } } }),
    );

    await expect(readMcpFile(join(dir, 'broken.json'))).rejects.toThrow('is not valid JSON');
    await expect(readMcpFile(join(dir, 'nocmd.json'))).rejects.toThrow('mcpServers.bad');
  });

  it('merges personal, project and heaw.config.ts servers, later ones winning', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'home.json'), '');
    const home = join(root, 'home');
    await writeServerToFile(join(home, 'mcp.json'), 'shared', { command: 'personal' });
    await writeServerToFile(join(home, 'mcp.json'), 'mine', { command: 'mine' });
    await writeServerToFile(join(root, '.mcp.json'), 'shared', { command: 'project' });

    const servers = await loadMcpServers({
      projectRoot: root,
      heawHome: home,
      fromConfig: { fromts: { url: 'https://x.dev/mcp' } },
    });

    expect(
      servers.map((server) => [
        server.name,
        'command' in server.config ? server.config.command : 'url',
      ]),
    ).toEqual([
      ['shared', 'project'],
      ['mine', 'mine'],
      ['fromts', 'url'],
    ]);
  });

  it('adds and removes servers without touching the rest of the file', async () => {
    const dir = await tempDir();
    const file = join(dir, '.mcp.json');
    await writeFile(
      file,
      JSON.stringify({ comment: 'keep me', mcpServers: { old: { command: 'x' } } }),
    );

    await writeServerToFile(file, 'new', { command: 'npx', args: ['y'] });
    expect(await removeServerFromFile(file, 'old')).toBe(true);
    expect(await removeServerFromFile(file, 'old')).toBe(false);

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      comment: 'keep me',
      mcpServers: { new: { command: 'npx', args: ['y'] } },
    });
  });

  it('expands ${VAR}, ${VAR:-default} and env()', () => {
    const environment = { TOKEN: 't', EMPTY: '' };
    expect(expandValue('Bearer ${TOKEN}', environment, 'x')).toBe('Bearer t');
    expect(expandValue('${EMPTY:-fallback}/${NOPE:-x}', environment, 'x')).toBe('fallback/x');
    expect(expandValue(env('TOKEN', { prefix: 'Bearer ' }), environment, 'x')).toBe('Bearer t');
    expect(() => expandValue('${NOPE}', environment, 'mcpServers.a.env.KEY')).toThrow(
      'mcpServers.a.env.KEY uses ${NOPE}, which is not set.',
    );
  });

  it('names tools mcp__server__tool, within provider limits', () => {
    expect(mcpToolName('github', 'get_issue')).toBe('mcp__github__get_issue');
    expect(mcpToolName('my server', 'do.it')).toBe('mcp__my_server__do_it');
    const long = mcpToolName(
      'a-very-long-server-name-indeed',
      'and_an_even_longer_tool_name_than_that',
    );
    expect(long).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe('MCP servers over stdio', () => {
  it('connects, lists tools with schemas and passes on server instructions', async () => {
    const manager = await start([entry('test', stdioServer())]);

    expect(manager.statuses()).toEqual([
      {
        name: 'test',
        status: 'connected',
        error: undefined,
        tools: 7,
        transport: 'stdio',
        source: 'test',
      },
    ]);
    expect(manager.instructions()).toEqual([
      { server: 'test', text: 'Use echo to repeat text back.' },
    ]);
    const echo = toolNamed(manager, 'mcp__test__echo');
    expect(echo).toMatchObject({
      kind: 'execute',
      description: 'Repeat the given text. (MCP server "test")',
    });
    expect(echo.inputSchema).not.toHaveProperty('$schema');
    expect(await call(echo, { text: 'hi' })).toEqual({ output: 'echo: hi', isError: false });
  });

  it('passes configured environment variables, expanding ${VAR}', async () => {
    const manager = await start([entry('test', stdioServer({ env: { SECRET: '${MY_SECRET}' } }))], {
      MY_SECRET: 's3',
    });

    expect(await call(toolNamed(manager, 'mcp__test__env'), { name: 'SECRET' })).toMatchObject({
      output: 's3',
    });
  });

  it('turns error results, images and bad arguments into readable output', async () => {
    const manager = await start([entry('test', stdioServer())]);

    expect(await call(toolNamed(manager, 'mcp__test__fail'), {})).toEqual({
      output: 'boom',
      isError: true,
    });
    expect((await call(toolNamed(manager, 'mcp__test__picture'), {})).output).toBe(
      '[image, image/png, 16 bytes]\na picture',
    );
    expect(toolNamed(manager, 'mcp__test__add').parse([1, 2])).toEqual({
      ok: false,
      error: 'Arguments must be an object.',
    });
  });

  it('times out slow calls and stops on abort', async () => {
    const manager = await start([entry('test', stdioServer({ timeoutSeconds: 0.5 }))]);
    const slow = toolNamed(manager, 'mcp__test__slow');

    await expect(call(slow, { ms: 5_000 })).rejects.toThrow(/timed out|timeout/i);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(call(slow, { ms: 5_000 }, controller.signal)).rejects.toThrow();
  });

  it('reports a server that crashes, and its tools disappear', async () => {
    const manager = await start([entry('test', stdioServer())]);

    await call(toolNamed(manager, 'mcp__test__crash'), {}).catch(() => undefined);
    await expect.poll(() => manager.statuses()[0]?.status, { timeout: 5_000 }).toBe('failed');

    expect(manager.statuses()[0]?.error).toMatch(/stopped/);
    expect(manager.tools()).toEqual([]);
  });

  it('reports a server that cannot start, without affecting the others', async () => {
    const manager = await start([
      entry('broken', { command: 'definitely-not-a-real-command-heaw' }),
      entry('test', stdioServer()),
    ]);

    const [broken, test] = manager.statuses();
    expect(broken).toMatchObject({ status: 'failed' });
    expect(broken?.error).toBeTruthy();
    expect(test).toMatchObject({ status: 'connected', tools: 7 });
  });

  it('filters tools and believes read-only hints only from trusted servers', async () => {
    const manager = await start([
      entry('picky', stdioServer({ includeTools: ['echo', 'add'], excludeTools: ['add'] })),
      entry('trusted', stdioServer({ trusted: true })),
    ]);

    expect(
      manager
        .tools()
        .filter((tool) => tool.name.startsWith('mcp__picky'))
        .map((tool) => tool.name),
    ).toEqual(['mcp__picky__echo']);
    expect(toolNamed(manager, 'mcp__picky__echo').kind).toBe('execute');
    expect(toolNamed(manager, 'mcp__trusted__echo').kind).toBe('read');
    expect(toolNamed(manager, 'mcp__trusted__add').kind).toBe('execute');
  });

  it('reloads: starts new and changed servers, stops removed ones, keeps the rest', async () => {
    const manager = await start([entry('a', stdioServer()), entry('b', stdioServer())]);

    const summary = await manager.load([
      entry('a', stdioServer()),
      entry('c', stdioServer({ trusted: true })),
    ]);
    await manager.ready(20_000);

    expect(summary).toEqual({ started: ['c'], stopped: ['b'], unchanged: ['a'] });
    expect(manager.statuses().map((server) => [server.name, server.status])).toEqual([
      ['a', 'connected'],
      ['c', 'connected'],
    ]);
  });

  it('skips disabled servers', async () => {
    const manager = await start([entry('off', stdioServer({ disabled: true }))]);
    expect(manager.statuses()[0]?.status).toBe('disabled');
  });
});

describe('MCP servers over HTTP', () => {
  it('connects with headers from the environment', async () => {
    const url = await httpServer('letmein');
    const manager = await start(
      [entry('remote', { url, headers: { Authorization: 'Bearer ${TOKEN}' } })],
      { TOKEN: 'letmein' },
    );

    expect(manager.statuses()[0]).toMatchObject({
      status: 'connected',
      transport: 'http',
      tools: 7,
    });
    expect(await call(toolNamed(manager, 'mcp__remote__add'), { a: 2, b: 3 })).toMatchObject({
      output: '5',
    });
  });

  it('explains refused credentials instead of suggesting a login', async () => {
    const url = await httpServer('letmein');
    const manager = await start([
      entry('remote', { url, headers: { Authorization: 'Bearer wrong' } }),
    ]);

    expect(manager.statuses()[0]).toMatchObject({ status: 'failed' });
    expect(manager.statuses()[0]?.error).toContain('refused the credentials');
  });

  it('reports a server that is not running', async () => {
    const manager = await start([entry('gone', { type: 'http', url: 'http://127.0.0.1:9/mcp' })]);
    expect(manager.statuses()[0]?.status).toBe('failed');
  });
});

describe('MCP in the engine', () => {
  it('offers MCP tools to the model, with permissions and server instructions', async () => {
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: 'mcp__test__echo', args: { text: 'hello' }, id: 'c1' }] },
      { text: 'done' },
    ]);
    const engine = await createEngine({
      model,
      toolsets: [],
      interactive: false,
      permissions: { allow: ['mcp__test__*'] },
      mcp: { servers: [entry('test', stdioServer())] },
    });

    await collect(engine.session().send('Echo hello'));
    await engine.dispose();

    expect(model.requests[0]?.tools?.map((tool) => tool.name)).toContain('mcp__test__echo');
    expect(model.requests[0]?.system).toContain(
      '<mcp-server-instructions server="test">\nUse echo to repeat text back.',
    );
    expect(model.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({ output: 'echo: hello' });
  });

  it('asks before MCP calls by default, so a one-shot run is denied with the rule to allow it', async () => {
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: 'mcp__test__add', args: { a: 1, b: 2 } }] },
      { text: 'ok' },
    ]);
    const engine = await createEngine({
      model,
      toolsets: [],
      interactive: false,
      mcp: { servers: [entry('test', stdioServer())] },
    });

    await collect(engine.session().send('Add'));
    await engine.dispose();

    expect(model.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      isError: true,
      output: expect.stringContaining('the rule "mcp__test__add"') as unknown,
    });
  });

  it('lets the agent add a server to .mcp.json and reload, then use the new tools', async () => {
    const project = await tempDir();
    const file = join(project, '.mcp.json');
    const config = JSON.stringify({ mcpServers: { added: stdioServer() } });
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: 'mcp_reload', args: {}, id: 'r1' }] },
      { toolCalls: [{ name: 'mcp__added__echo', args: { text: 'new tool' }, id: 'e1' }] },
      { text: 'Installed and used.' },
    ]);
    const engine = await createEngine({
      model,
      toolsets: ['mcp'],
      interactive: false,
      permissions: { allow: ['mcp_reload', 'mcp__added__*'] },
      mcp: {
        servers: [],
        reload: () => loadMcpServers({ projectRoot: project, heawHome: join(project, 'none') }),
      },
    });
    // The agent would write this with write_file (and an approval); here it is already written.
    await writeFile(file, config);

    await collect(engine.session().send('Add the test server'));
    await engine.dispose();

    const reload = model.requests[1]?.messages.at(-1)?.content[0] as { output: string };
    expect(reload.output).toContain('Started: added.');
    expect(reload.output).toContain('added: connected (stdio, 7 tools)');
    expect(model.requests[1]?.tools?.map((tool) => tool.name)).toContain('mcp__added__echo');
    expect(model.requests[2]?.messages.at(-1)?.content[0]).toMatchObject({
      output: 'echo: new tool',
    });
  });
});

describe("an agent's own MCP servers", () => {
  const tester = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
    name: 'tester',
    description: 'Uses the app like a user.',
    prompt: 'You test the app.',
    tools: ['read_file'],
    mcpServers: [entry('browser', stdioServer())],
    source: 'test',
    ...extra,
  });
  const lastOutput = (model: ScriptedModelClient, index: number) =>
    model.requests[index]?.messages.at(-1)?.content[0];

  it('are read from the agent file, in the shape of .mcp.json', () => {
    const file = [
      '---',
      'name: tester',
      'description: Uses the app like a user.',
      'mcpServers:',
      '  browser:',
      '    command: npx',
      '    args: ["-y", "@playwright/mcp@0.0.83", "--headless"]',
      '    excludeTools: [browser_run_code_unsafe]',
      '---',
      'Test it.',
    ].join('\n');
    const { definition } = parseAgentDefinition(file, '/p/.heaw/agents/tester.md');
    expect(definition.mcpServers).toEqual([
      {
        name: 'browser',
        config: {
          command: 'npx',
          args: ['-y', '@playwright/mcp@0.0.83', '--headless'],
          excludeTools: ['browser_run_code_unsafe'],
        },
        source: '/p/.heaw/agents/tester.md',
      },
    ]);
    const bad = file.replace('    command: npx\n', '');
    expect(() => parseAgentDefinition(bad, 'tester.md')).toThrow(/mcpServers\.browser/);
    const list = 'name: t\ndescription: d\nmcpServers: [browser]';
    expect(() => parseAgentDefinition(`---\n${list}\n---\n`, 't.md')).toThrow(
      'mcpServers must map server names to their settings',
    );
  });

  it('give their tools to that agent only, allowed for it with nobody to ask', async () => {
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: 'delegate', args: { agent: 'tester', task: 'Add 1 and 2' } }] },
      { toolCalls: [{ name: 'mcp__browser__add', args: { a: 1, b: 2 } }] },
      { text: 'It shows 3.' },
      { text: 'The tester says 3.' },
    ]);
    const engine = await createEngine({
      model,
      toolsets: ['fs', 'agents'],
      interactive: false,
      git: false,
      agents: [tester()],
    });

    await collect(engine.session().send('Test it'));
    await engine.dispose();

    const names = (index: number) => model.requests[index]?.tools?.map((tool) => tool.name) ?? [];
    expect(names(0).some((name) => name.startsWith('mcp__'))).toBe(false);
    expect(names(1)).toEqual(expect.arrayContaining(['read_file', 'mcp__browser__add']));
    expect(names(1)).not.toContain('write_file');
    expect(model.requests[1]?.system).toContain('Use echo to repeat text back.');
    expect(model.requests[0]?.system).not.toContain('Use echo to repeat text back.');
    expect(lastOutput(model, 2)).toMatchObject({ output: '3' });
  });

  it('that did not start are named to the agent, with why', async () => {
    const model = new ScriptedModelClient([{ text: 'Verdict: could not test' }]);
    const broken = entry('browser', { command: 'heaw-no-such-command-xyz' });
    const engine = await createEngine({
      model,
      toolsets: ['fs'],
      interactive: false,
      git: false,
      agents: [tester({ mcpServers: [broken] })],
    });

    await engine.runAgent('tester', 'Check the page');
    await engine.dispose();

    expect(model.requests[0]?.system).toMatch(
      /The MCP server "browser" of your agent file is failed: .+\. Its tools are missing/,
    );
  });

  it('run for a named agent run from code or a hook, and deny rules still apply', async () => {
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: 'mcp__browser__echo', args: { text: 'hi' } }] },
      { toolCalls: [{ name: 'mcp__browser__add', args: { a: 1, b: 2 } }] },
      { text: 'done' },
    ]);
    const engine = await createEngine({
      model,
      toolsets: ['fs'],
      interactive: false,
      git: false,
      agents: [tester()],
      permissions: { deny: ['mcp__browser__add'] },
    });

    const result = await engine.runAgent('tester', 'Check the page');
    await engine.dispose();

    expect(result.stopReason).toBe('end_turn');
    expect(lastOutput(model, 1)).toMatchObject({ output: 'echo: hi' });
    expect(lastOutput(model, 2)).toMatchObject({
      isError: true,
      output: expect.stringContaining('deny rule "mcp__browser__add"') as unknown,
    });
  });
});

describe('images from tools', () => {
  const pictures = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      toolCalls: [{ name: 'mcp__test__picture', args: {}, id: `p${index}` }],
    }));
  const toolResults = (request: ModelRequest | undefined) =>
    (request?.messages ?? []).flatMap((message) =>
      message.role === 'tool' ? message.content : [],
    );

  it('reach a model that can see, the latest three only, and are never saved', async () => {
    const model = new ScriptedModelClient([...pictures(4), { text: 'Seen.' }], {
      capabilities: { vision: true },
    });
    const root = await tempDir();
    const store = new JsonlSessionStore(root);
    const engine = await createEngine({
      model,
      toolsets: [],
      interactive: false,
      git: false,
      permissions: { allow: ['mcp__test__*'] },
      mcp: { servers: [entry('test', stdioServer())] },
      sessionStore: store,
    });

    const session = engine.session();
    await collect(session.send('Look at it'));
    await engine.dispose();

    const results = toolResults(model.requests[4]);
    expect(results.map((part) => part.images?.length ?? 0)).toEqual([0, 1, 1, 1]);
    expect(results[3]?.images?.[0]).toEqual({
      mediaType: 'image/png',
      data: Buffer.from('not really a png').toString('base64'),
    });
    // The description stays for the older ones, and for models that cannot see.
    expect(results[0]?.output).toBe('[image, image/png, 16 bytes]\na picture');
    const saved = JSON.stringify(await store.load(session.id));
    expect(saved).toContain('[image, image/png, 16 bytes]');
    expect(saved).not.toContain(Buffer.from('not really a png').toString('base64'));
  });

  it('reach a model that cannot see only as their description', async () => {
    const model = new ScriptedModelClient([...pictures(1), { text: 'Read.' }]);
    const engine = await createEngine({
      model,
      toolsets: [],
      interactive: false,
      git: false,
      permissions: { allow: ['mcp__test__*'] },
      mcp: { servers: [entry('test', stdioServer())] },
    });

    await collect(engine.session().send('Look at it'));
    await engine.dispose();

    expect(toolResults(model.requests[1])).toMatchObject([
      { output: '[image, image/png, 16 bytes]\na picture' },
    ]);
    expect(toolResults(model.requests[1])[0]?.images).toBeUndefined();
  });
});

describe('MCP tools on demand', () => {
  const names = (request: ModelRequest | undefined) =>
    request?.tools?.map((tool) => tool.name) ?? [];
  const lastOutput = (request: ModelRequest | undefined) =>
    request?.messages.at(-1)?.content[0] as { output?: string; isError?: boolean } | undefined;

  it('lists the tools, and sends a schema only once the agent has loaded the tool', async () => {
    const model = new ScriptedModelClient([
      { toolCalls: [{ name: 'mcp__test__add', args: { a: 1, b: 2 } }] },
      { toolCalls: [{ name: 'load_tools', args: { names: ['mcp__test__add', 'mcp__nope'] } }] },
      { toolCalls: [{ name: 'mcp__test__add', args: { a: 1, b: 2 } }] },
      { text: '3' },
    ]);
    const engine = await createEngine({
      model,
      toolsets: [],
      interactive: false,
      git: false,
      permissions: { allow: ['mcp__test__*'] },
      mcp: { servers: [entry('test', stdioServer())], tools: 'on-demand' },
    });

    await collect(engine.session().send('Add 1 and 2'));
    await engine.dispose();

    expect(names(model.requests[0])).toEqual(['load_tools']);
    expect(model.requests[0]?.system).toContain('## MCP tools on demand');
    expect(model.requests[0]?.system).toContain('- mcp__test__echo: Repeat the given text.');
    expect(lastOutput(model.requests[1])).toMatchObject({
      isError: true,
      output: expect.stringContaining('has to be loaded with load_tools first') as unknown,
    });
    expect(lastOutput(model.requests[2])?.output).toBe(
      'Loaded: mcp__test__add. Call them from your next step.\nNot found: mcp__nope.',
    );
    expect(names(model.requests[2])).toEqual(['mcp__test__add', 'load_tools']);
    expect(lastOutput(model.requests[3])?.output).toBe('3');
    // The list stays as it was, so the cached start of the prompt stays valid.
    expect(model.requests[3]?.system).toBe(model.requests[0]?.system);
  });

  it('sends every tool while there are few, and keeps what a resumed conversation loaded', async () => {
    const few = new ScriptedModelClient([{ text: 'ok' }]);
    const allSent = await createEngine({
      model: few,
      toolsets: [],
      interactive: false,
      git: false,
      mcp: { servers: [entry('test', stdioServer())] },
    });
    await collect(allSent.session().send('Hi'));
    await allSent.dispose();
    expect(names(few.requests[0])).toContain('mcp__test__echo');
    expect(names(few.requests[0])).not.toContain('load_tools');

    const store = new JsonlSessionStore(await tempDir());
    const options = {
      toolsets: [],
      interactive: false,
      git: false,
      sessionStore: store,
      mcp: { servers: [entry('test', stdioServer())], tools: 'on-demand' as const },
    };
    const first = await createEngine({
      ...options,
      model: new ScriptedModelClient([
        { toolCalls: [{ name: 'load_tools', args: { names: ['mcp__test__echo'] } }] },
        { text: 'Loaded.' },
      ]),
    });
    const session = first.session();
    await collect(session.send('Load echo'));
    await first.dispose();

    const later = new ScriptedModelClient([{ text: 'Still here.' }]);
    const second = await createEngine({ ...options, model: later });
    await collect((await second.resume(session.id)).send('Go on'));
    await second.dispose();
    expect(names(later.requests[0])).toEqual(['mcp__test__echo', 'load_tools']);
  });
});
