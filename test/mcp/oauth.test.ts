import { type ChildProcess, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSlashCommand } from '../../src/cli/chat/commands.js';
import {
  mcpAdd,
  type McpContext,
  mcpLogin,
  mcpLogout,
  mcpTest,
} from '../../src/cli/commands/mcp.js';
import { createEngine, type Engine } from '../../src/engine.js';
import type { McpServerEntry } from '../../src/mcp/config.js';
import { McpManager } from '../../src/mcp/manager.js';
import {
  loginToMcpServer,
  McpCredentialStore,
  McpOAuthProvider,
  oauthSettingsOf,
} from '../../src/mcp/oauth.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const FIXTURE = resolve('test/fixtures/mcp-test-server.mjs');
const children: ChildProcess[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  for (const child of children.splice(0)) child.kill();
});

interface Stats {
  registrations: number;
  authorizations: number;
  refreshes: number;
}

/** Starts the fixture as an MCP server that is its own OAuth authorization server. */
async function oauthServer(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [FIXTURE, 'http', '0'], {
    env: { ...process.env, OAUTH: '1', ...env },
  });
  children.push(child);
  const port = await new Promise<string>((done, fail) => {
    child.stdout.on('data', (chunk: Buffer) => {
      const match = /listening (\d+)/.exec(chunk.toString());
      if (match) done(match[1]!);
    });
    child.on('exit', () => fail(new Error('test server exited')));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    url: `${base}/mcp`,
    stats: async () => (await (await fetch(`${base}/test/stats`)).json()) as Stats,
    expire: () => fetch(`${base}/test/expire`, { method: 'POST' }),
  };
}

/** Plays the browser: opens the login page, which sends it straight back to heaw. */
async function browser(url: URL): Promise<void> {
  await pageAt(url);
}

/** The page the browser ends up on. */
async function pageAt(url: URL): Promise<string> {
  return (await fetch(url)).text();
}

async function connect(store: McpCredentialStore, entry: McpServerEntry) {
  const manager = new McpManager({
    env: {},
    cwd: process.cwd(),
    clientInfo: { name: 'test', version: '0' },
    authProvider: (server, url) =>
      new McpOAuthProvider(store, url.href, oauthSettingsOf(server, {})),
  });
  cleanups.push(() => manager.dispose());
  await manager.load([entry]);
  await manager.ready(20_000);
  return manager;
}

const remote = (url: string): McpServerEntry => ({
  name: 'remote',
  config: { url, oauth: true },
  source: '.mcp.json',
});

describe('MCP OAuth', () => {
  it('connects only after a login, and registers nothing before one', async () => {
    const server = await oauthServer();
    const store = new McpCredentialStore(join(await tempDir(), 'credentials'));

    const before = await connect(store, remote(server.url));
    expect(before.statuses()[0]).toMatchObject({
      status: 'needs-login',
      error: 'needs a login: heaw mcp login remote, or /mcp login remote in the chat',
    });
    expect(await server.stats()).toEqual({ registrations: 0, authorizations: 0, refreshes: 0 });

    await loginToMcpServer({ store, serverUrl: server.url, onAuthorizationUrl: browser });

    const saved = await store.read(server.url);
    expect(saved).toMatchObject({
      serverUrl: server.url,
      redirectUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/) as unknown,
      client: { client_id: 'client-1' },
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1' },
    });
    if (process.platform !== 'win32') {
      expect((await stat(store.fileFor(server.url))).mode & 0o777).toBe(0o600);
    }

    const after = await connect(store, remote(server.url));
    expect(after.statuses()[0]).toMatchObject({ status: 'connected', tools: 7 });
  }, 30_000);

  it('refreshes expired tokens while connecting', async () => {
    const server = await oauthServer();
    const store = new McpCredentialStore(join(await tempDir(), 'credentials'));
    await loginToMcpServer({ store, serverUrl: server.url, onAuthorizationUrl: browser });
    await server.expire();

    const manager = await connect(store, remote(server.url));

    expect(manager.statuses()[0]?.status).toBe('connected');
    expect((await server.stats()).refreshes).toBe(1);
    expect((await store.read(server.url))?.tokens?.access_token).toBe('access-2');
  }, 30_000);

  it('logs in again with the same client and callback address', async () => {
    const server = await oauthServer();
    const store = new McpCredentialStore(join(await tempDir(), 'credentials'));

    await loginToMcpServer({ store, serverUrl: server.url, onAuthorizationUrl: browser });
    const first = await store.read(server.url);
    await loginToMcpServer({ store, serverUrl: server.url, onAuthorizationUrl: browser });

    expect((await store.read(server.url))?.redirectUrl).toBe(first?.redirectUrl);
    expect(await server.stats()).toMatchObject({ registrations: 1, authorizations: 2 });
  }, 30_000);

  it('reports a refused login, escaping what the server said', async () => {
    const server = await oauthServer({ OAUTH_DENY: '1' });
    const store = new McpCredentialStore(join(await tempDir(), 'credentials'));
    let page = '';

    await expect(
      loginToMcpServer({
        store,
        serverUrl: server.url,
        onAuthorizationUrl: async (url) => {
          page = await pageAt(url);
        },
      }),
    ).rejects.toThrow('The login failed: The user said <no>');
    expect(page).toContain('The user said &#60;no&#62;');
    expect((await store.read(server.url))?.tokens).toBeUndefined();
  }, 30_000);

  it('ignores callbacks that are not from its login, and gives up after the timeout', async () => {
    const server = await oauthServer();
    const store = new McpCredentialStore(join(await tempDir(), 'credentials'));
    let page = '';

    await expect(
      loginToMcpServer({
        store,
        serverUrl: server.url,
        timeoutMs: 1_000,
        onAuthorizationUrl: async (url) => {
          const callback = new URL(url.searchParams.get('redirect_uri')!);
          callback.searchParams.set('state', 'forged');
          callback.searchParams.set('code', 'stolen');
          page = await pageAt(callback);
        },
      }),
    ).rejects.toThrow('No login within 1 seconds.');
    expect(page).toContain('This page is not from the login heaw started.');
  }, 30_000);

  it('uses a client from the config without saving it, and forgets logins on logout', async () => {
    const dir = await tempDir();
    const store = new McpCredentialStore(join(dir, 'credentials'));
    const entry: McpServerEntry = {
      name: 'preset',
      config: {
        url: 'https://example.com/mcp',
        oauth: { clientId: 'my-app', clientSecret: '${APP_SECRET}', scopes: ['read', 'write'] },
      },
      source: 'test',
    };
    const settings = oauthSettingsOf(entry, { APP_SECRET: 's3cret' });
    const provider = new McpOAuthProvider(store, 'https://example.com/mcp', settings);

    expect(await provider.clientInformation()).toEqual({
      client_id: 'my-app',
      client_secret: 's3cret',
    });
    expect(provider.clientMetadata).toMatchObject({
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'read write',
    });
    await provider.saveClientInformation({ client_id: 'my-app', issuer: 'https://example.com' });
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' });
    expect(await store.read('https://example.com/mcp')).toEqual({
      serverUrl: 'https://example.com/mcp',
      tokens: { access_token: 'a', token_type: 'Bearer' },
    });

    expect(await store.remove('https://example.com/mcp')).toBe(true);
    expect(await store.remove('https://example.com/mcp')).toBe(false);
    await expect(
      new McpOAuthProvider(store, 'https://example.com/mcp').clientInformation(),
    ).rejects.toThrow('Not logged in.');
  });
});

describe('logging in from the CLI and the chat', () => {
  async function project() {
    const cwd = await tempDir();
    let text = '';
    const stdout = { write: (chunk: string) => (text += chunk) };
    const context: McpContext = {
      cwd,
      env: { HEAW_HOME: join(cwd, 'home') },
      stdout,
      stderr: stdout,
      packageEntry: resolve('src/index.ts'),
      openUrl: async (url) => {
        await browser(url);
        return true;
      },
    };
    return { context, output: () => text };
  }

  it('heaw mcp login and logout', async () => {
    const server = await oauthServer();
    const { context, output } = await project();
    await mcpAdd('remote', [], { url: server.url, oauth: true }, context);
    await mcpAdd('plain', [], { url: server.url }, context);
    await mcpAdd('local', ['node', 'x.js'], {}, context);

    expect(await mcpTest('remote', context)).toBe(1);
    expect(await mcpLogin('remote', context)).toBe(0);
    expect(await mcpTest('remote', context)).toBe(0);
    expect(await mcpLogout('remote', context)).toBe(0);
    expect(await mcpLogout('remote', context)).toBe(0);
    expect(await mcpLogin('plain', context)).toBe(2);
    expect(await mcpLogin('local', context)).toBe(2);

    const text = output();
    expect(text).toContain('remote: needs-login');
    expect(text).toContain(
      'Log in in your browser. If it did not open, visit:\n  http://127.0.0.1:',
    );
    expect(text).toMatch(
      /Logged in to "remote"\. The login is saved in home[\\/]credentials[\\/]mcp/,
    );
    expect(text).toContain('remote: connected (http, 7 tools)');
    expect(text).toContain('Logged out of "remote".');
    expect(text).toContain('Not logged in to "remote".');
    expect(text).toContain('"plain" is not set up for a login: add "oauth": true to it in');
    expect(text).toContain('"local" is a local server; logins are for remote servers.');
  }, 60_000);

  it('/mcp login in the chat connects the server afterwards', async () => {
    const server = await oauthServer();
    const dir = await tempDir();
    const engine = await createEngine({
      model: new ScriptedModelClient([]),
      toolsets: [],
      mcp: { servers: [remote(server.url)], credentialsDir: join(dir, 'credentials') },
    });
    cleanups.push(() => engine.dispose());
    await settled(engine);
    const printed: string[] = [];
    const ctx = {
      engine,
      session: () => engine.session(),
      print: (text: string) => printed.push(text),
      newSession: () => undefined,
      refresh: () => undefined,
      exit: () => undefined,
      openUrl: async (url: URL) => {
        await browser(url);
        return false;
      },
    };

    expect(engine.mcpServers()[0]?.status).toBe('needs-login');
    await runSlashCommand('/mcp login remote', ctx);
    await runSlashCommand('/mcp login nothing', ctx);

    expect(printed[0]).toMatch(/^Log in on this page:\nhttp:\/\/127\.0\.0\.1:\d+\/authorize\?/);
    expect(printed[1]).toBe('remote: connected (http, 7 tools)');
    expect(printed[2]).toBe('Could not log in to "nothing": No MCP server named "nothing".');
    expect(engine.tools.map((tool) => tool.name)).toContain('mcp__remote__echo');
  }, 30_000);
});

/** Resolves once no MCP server of the engine is still connecting. */
function settled(engine: Engine): Promise<void> {
  const done = () => engine.mcpServers().every((server) => server.status !== 'connecting');
  return new Promise((resolveSettled) => {
    if (done()) return resolveSettled();
    const stop = engine.onMcpChange(() => {
      if (!done()) return;
      stop();
      resolveSettled();
    });
  });
}
