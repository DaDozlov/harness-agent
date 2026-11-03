import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSlashCommand } from '../../src/cli/chat/commands.js';
import {
  mcpAdd,
  type McpContext,
  mcpErrorMessage,
  mcpInstall,
  mcpList,
  mcpRemove,
  mcpSearch,
  mcpTest,
} from '../../src/cli/commands/mcp.js';
import { createEngine, type Engine } from '../../src/engine.js';
import type { RegistryServer } from '../../src/mcp/registry.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const FIXTURE = resolve('test/fixtures/mcp-test-server.mjs');
const PACKAGE_ENTRY = resolve('src/index.ts');
const RECORDED = JSON.parse(
  readFileSync(resolve('test/fixtures/registry-servers.json'), 'utf8'),
) as RegistryServer[];

function output() {
  let text = '';
  return {
    write: (chunk: string) => (text += chunk),
    get text() {
      return text;
    },
  };
}

/** A project in a temporary folder, with personal settings kept out of the real home. */
async function project(registry: RegistryServer[] = RECORDED) {
  const cwd = await tempDir();
  const stdout = output();
  const stderr = output();
  const context: McpContext = {
    cwd,
    env: { HEAW_HOME: join(cwd, 'home') },
    stdout,
    stderr,
    packageEntry: PACKAGE_ENTRY,
    registry: {
      fetch: () =>
        Promise.resolve(Response.json({ servers: registry.map((server) => ({ server })) })),
    },
  };
  const read = async (file = '.mcp.json') =>
    JSON.parse(await readFile(join(cwd, file), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
  return { cwd, stdout, stderr, context, read };
}

describe('heaw mcp add, list, test and remove', () => {
  it('adds local and remote servers to .mcp.json, or to the personal file', async () => {
    const { context, stdout, read } = await project();

    expect(
      await mcpAdd(
        'files',
        ['npx', '-y', 'some-server'],
        { env: ['TOKEN=${MY_TOKEN}'], trusted: true },
        context,
      ),
    ).toBe(0);
    expect(
      await mcpAdd(
        'remote',
        [],
        { url: 'https://example.com/mcp', header: ['Authorization: Bearer ${KEY}'] },
        context,
      ),
    ).toBe(0);
    await mcpAdd(
      'mine',
      [],
      { url: 'https://x.dev/sse', transport: 'sse', oauth: true, scope: 'personal' },
      context,
    );

    expect((await read()).mcpServers).toEqual({
      files: {
        command: 'npx',
        args: ['-y', 'some-server'],
        env: { TOKEN: '${MY_TOKEN}' },
        trusted: true,
      },
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${KEY}' } },
    });
    expect((await read(join('home', 'mcp.json'))).mcpServers).toEqual({
      mine: { type: 'sse', url: 'https://x.dev/sse', oauth: true },
    });
    expect(stdout.text).toContain('Added "files" to .mcp.json. Check it with: heaw mcp test files');
  });

  it('rejects bad names, missing commands and malformed pairs', async () => {
    const { context, stderr } = await project();

    expect(await mcpAdd('bad name', ['x'], {}, context)).toBe(2);
    expect(await mcpAdd('empty', [], {}, context)).toBe(2);
    expect(await mcpAdd('pairs', ['x'], { env: ['NOVALUE'] }, context)).toBe(2);

    expect(stderr.text).toContain('Use letters, digits, - and _ for the server name.');
    expect(stderr.text).toContain('heaw mcp add empty -- npx -y <package>');
    expect(stderr.text).toContain('Expected --env KEY=VALUE, got "NOVALUE".');
  });

  it('lists servers with their status and fails when one cannot start', async () => {
    const { context, stdout } = await project();
    await mcpAdd('test', [process.execPath, FIXTURE], {}, context);
    await mcpAdd('broken', [process.execPath, join(context.cwd, 'missing.mjs')], {}, context);

    expect(await mcpList(context)).toBe(1);

    expect(stdout.text).toContain('MCP servers (2):');
    expect(stdout.text).toContain('test: connected (stdio, 7 tools)  [.mcp.json]');
    // The server's own error line, not the end of its stack trace.
    expect(stdout.text).toMatch(
      /broken: failed — .*\(server output: Error: Cannot find module .*missing\.mjs'\) {2}\[\.mcp\.json\]\n/,
    );
  }, 30_000);

  it('says how to add servers when there are none', async () => {
    const { context, stdout } = await project();

    expect(await mcpList(context)).toBe(0);

    expect(stdout.text).toContain('No MCP servers configured.');
  });

  it("tests one server, showing its tools and the server's instructions", async () => {
    const { context, stdout, stderr } = await project();
    await mcpAdd('test', [process.execPath, FIXTURE], {}, context);

    expect(await mcpTest('test', context)).toBe(0);
    expect(await mcpTest('other', context)).toBe(2);

    expect(stdout.text).toContain('test: connected (stdio, 7 tools)');
    expect(stdout.text).toMatch(/ {2}mcp__test__echo {2}\S/);
    expect(stdout.text).toContain('Instructions from the server:\nUse echo to repeat text back.');
    expect(stderr.text).toContain('No MCP server named "other". See heaw mcp list.');
  }, 30_000);

  it('removes servers from the file that defines them', async () => {
    const { cwd, context, stdout, stderr, read } = await project();
    await mcpAdd('a', ['x'], {}, context);
    await mcpAdd('b', ['x'], { scope: 'personal' }, context);
    await writeFile(
      join(cwd, 'heaw.config.ts'),
      "export default { mcpServers: { fromts: { command: 'x' } } };",
    );

    expect(await mcpRemove('a', {}, context)).toBe(0);
    expect(await mcpRemove('b', {}, context)).toBe(0);
    expect(await mcpRemove('fromts', {}, context)).toBe(2);
    expect(await mcpRemove('none', {}, context)).toBe(2);

    expect((await read()).mcpServers).toEqual({});
    expect(stdout.text).toContain('Removed "a" from .mcp.json.');
    expect(stderr.text).toContain('"fromts" is defined in heaw.config.ts; remove it there.');
    expect(stderr.text).toContain('No MCP server named "none".');
  });
});

describe('heaw mcp search and install', () => {
  it('shows registry servers and how to install one', async () => {
    const { context, stdout } = await project();

    expect(await mcpSearch('atlassian', context)).toBe(0);

    expect(stdout.text).toContain('com.atlassian/atlassian-mcp-server (v');
    expect(stdout.text).toContain('runs as: remote server https://mcp.atlassian.com/v2/mcp');
    expect(stdout.text).toContain('Install one with: heaw mcp install <name>');
  });

  it('installs a registry server and explains its variables and what was left out', async () => {
    const { context, stdout, read } = await project();

    expect(await mcpInstall('com.pulsemcp/gcs', {}, context)).toBe(0);
    expect(await mcpInstall('io.github.github/github-mcp-server', { as: 'gh' }, context)).toBe(0);

    const { mcpServers } = await read();
    expect(Object.keys(mcpServers)).toEqual(['gcs', 'gh']);
    expect(stdout.text).toContain(
      'Installed "gcs" from the MCP Registry (npm package gcs-google-mcp-server@0.1.14) into .mcp.json.',
    );
    expect(stdout.text).toContain(
      'Set these in your environment or .env before using it:\n  GCS_PROJECT_ID — Google Cloud project ID.',
    );
    expect(stdout.text).toContain('SKIP_HEALTH_CHECKS (default: false)');
    expect(stdout.text).toContain('"GCS_BUCKET": "${GCS_BUCKET}" (in "env")');
    expect(stdout.text).toContain('"-e", "GITHUB_PERSONAL_ACCESS_TOKEN=${GH_TOKEN}"');
    expect(stdout.text).toContain('Then try it: heaw mcp test gh');
  });

  it('suggests a login for remote servers without credentials', async () => {
    const { context, stdout, read } = await project();

    await mcpInstall('com.atlassian/atlassian-mcp-server', {}, context);

    expect((await read()).mcpServers['atlassian']).toEqual({
      type: 'http',
      url: 'https://mcp.atlassian.com/v2/mcp',
      oauth: true,
    });
    expect(stdout.text).toContain('If it asks for a login: heaw mcp login atlassian');
  });

  it('explains unknown names, bad local names and servers heaw cannot run', async () => {
    const nuget: RegistryServer = {
      name: 'io.github.someone/dotnet-tool',
      version: '1.0.0',
      packages: [{ registryType: 'nuget', identifier: 'Some.Tool' }],
    };
    const { context, stderr } = await project([...RECORDED, nuget]);

    expect(await mcpInstall('io.github.someone/missing', {}, context)).toBe(2);
    expect(await mcpInstall('com.pulsemcp/gcs', { as: 'no spaces' }, context)).toBe(2);
    expect(await mcpInstall(nuget.name, {}, context)).toBe(2);

    expect(stderr.text).toContain(
      'No server named "io.github.someone/missing" in the MCP Registry.',
    );
    expect(stderr.text).toContain('(--as <name>)');
    expect(stderr.text).toContain('heaw cannot run "io.github.someone/dotnet-tool" yet');
  });

  it('turns network failures into a message instead of a stack trace', async () => {
    const { context } = await project();
    const offline: McpContext = {
      ...context,
      registry: {
        fetch: () =>
          Promise.reject(
            new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND registry') }),
          ),
      },
    };

    const error = await mcpSearch('jira', offline).catch((caught: unknown) => caught);

    expect(mcpErrorMessage(error)).toBe(
      'Could not reach the MCP Registry at https://registry.modelcontextprotocol.io: getaddrinfo ENOTFOUND registry.',
    );
    expect(mcpErrorMessage(new Error('a bug'))).toBeUndefined();
  });
});

/** Resolves once no MCP server of the engine is still connecting. */
function connected(engine: Engine): Promise<void> {
  const settled = () => engine.mcpServers().every((server) => server.status !== 'connecting');
  return new Promise((done) => {
    if (settled()) return done();
    const stop = engine.onMcpChange(() => {
      if (!settled()) return;
      stop();
      done();
    });
  });
}

describe('/mcp in the chat', () => {
  async function chat(servers = false) {
    const engine = await createEngine({
      model: new ScriptedModelClient([]),
      toolsets: [],
      ...(servers && {
        mcp: {
          servers: [
            {
              name: 'test',
              config: { command: process.execPath, args: [FIXTURE] },
              source: 'test',
            },
          ],
        },
      }),
    });
    const printed: Array<[string, string]> = [];
    const ctx = {
      engine,
      session: () => engine.session(),
      print: (text: string, tone: 'info' | 'warning' | 'error' = 'info') =>
        printed.push([tone, text]),
      newSession: () => undefined,
      refresh: () => undefined,
      exit: () => undefined,
    };
    return { engine, printed, ctx };
  }

  it('shows the servers, or how to add one', async () => {
    const empty = await chat();
    await runSlashCommand('/mcp', empty.ctx);
    await runSlashCommand('/mcp frobnicate', empty.ctx);
    await runSlashCommand('/mcp reload', empty.ctx);
    await empty.engine.dispose();

    expect(empty.printed).toEqual([
      ['info', 'No MCP servers. Add one with heaw mcp add, or ask me to find and install one.'],
      ['error', 'Unknown option "frobnicate". Use /mcp, /mcp reload or /mcp login <server>.'],
      ['info', 'Reloading MCP servers…'],
      ['info', 'MCP servers cannot be reloaded in this setup.'],
    ]);

    const withServer = await chat(true);
    await connected(withServer.engine);
    await runSlashCommand('/mcp', withServer.ctx);
    await withServer.engine.dispose();

    expect(withServer.printed).toEqual([['info', 'test: connected (stdio, 7 tools)']]);
  }, 30_000);
});
