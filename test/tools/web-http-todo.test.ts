import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTranscript,
  itemsFromHistory,
  transcriptReducer,
} from '../../src/cli/chat/transcript.js';
import { validateConfig } from '../../src/config/schema.js';
import { createEngine } from '../../src/engine.js';
import { emptyUsage } from '../../src/core/usage.js';
import { env } from '../../src/providers/settings.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { httpRequestTool } from '../../src/tools/http.js';
import { TODO_STATE, todoWrite } from '../../src/tools/todo.js';
import { webFetch } from '../../src/tools/web.js';
import { callTool, collect, toolContext, tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();
const EVENT_BASE = { sessionId: 's', agentId: 'main', timestamp: 0 };
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** A local web server; `handle` answers each request. */
async function serve(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => handle(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

async function context() {
  return toolContext(await tempWorkspace());
}

describe('web_fetch', () => {
  async function site() {
    const port = await serve((req, res) => {
      const pages: Record<string, () => void> = {
        '/page': () =>
          res
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(
              '<html><head><title>The  Guide</title><script>evil()</script></head><body>' +
                '<nav>Menu</nav><h1>Install</h1><p>Run <code>npm i</code> and <a href="/next">go on</a>.</p>' +
                '<ul><li>one</li><li>two</li></ul><footer>© someone</footer></body></html>',
            ),
        '/data': () =>
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'),
        '/moved': () => res.writeHead(301, { location: '/page' }).end(),
        '/elsewhere': () => res.writeHead(302, { location: `http://localhost:${port}/page` }).end(),
        '/image': () => res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(64)),
        '/long': () => res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(2_500)),
        '/latin1': () =>
          res
            .writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' })
            .end(Buffer.from([0x63, 0x61, 0x66, 0xe9])),
      };
      (
        pages[req.url ?? ''] ??
        (() => res.writeHead(404, { 'content-type': 'text/plain' }).end('no such page'))
      )();
    });
    return `http://127.0.0.1:${port}`;
  }

  it('turns HTML into Markdown without scripts and page furniture', async () => {
    const base = await site();

    const { output, isError } = await callTool(webFetch, { url: `${base}/page` }, await context());

    expect(isError).toBe(false);
    expect(output).toContain(`URL: ${base}/page\nTitle: The Guide\n`);
    expect(output).toContain('# Install');
    expect(output).toContain('Run `npm i` and [go on](/next).');
    expect(output).toMatch(/\* one\n\* two/);
    expect(output).not.toMatch(/evil|Menu|someone/);
  });

  it('returns JSON and text as they are, decoding the charset', async () => {
    const base = await site();
    const ctx = await context();

    expect((await callTool(webFetch, { url: `${base}/data` }, ctx)).output).toContain(
      '{"ok":true}',
    );
    expect((await callTool(webFetch, { url: `${base}/latin1` }, ctx)).output).toContain('café');
  });

  it('follows redirects on the same host and reports one to another host', async () => {
    const base = await site();
    const ctx = await context();

    expect((await callTool(webFetch, { url: `${base}/moved` }, ctx)).output).toContain('# Install');
    const elsewhere = await callTool(webFetch, { url: `${base}/elsewhere` }, ctx);
    expect(elsewhere.output).toContain('redirects to another host: http://localhost:');
    expect(elsewhere.output).not.toContain('# Install');
  });

  it('pages through long content and explains what it cannot show', async () => {
    const base = await site();
    const ctx = await context();

    const first = await callTool(webFetch, { url: `${base}/long`, max_length: 1_000 }, ctx);
    expect(first.output).toContain(
      '[Characters 0–1000 of 2500. To read on, call web_fetch with start_index 1000.]',
    );
    const last = await callTool(
      webFetch,
      { url: `${base}/long`, start_index: 2_000, max_length: 1_000 },
      ctx,
    );
    expect(last.output).toContain('[Characters 2000–2500 of 2500.]');
    expect((await callTool(webFetch, { url: `${base}/image` }, ctx)).output).toContain(
      '[image/png, 64 bytes: not text, so not shown]',
    );
    expect(await callTool(webFetch, { url: `${base}/missing` }, ctx)).toMatchObject({
      isError: true,
      output: expect.stringContaining('HTTP 404 Not Found\n\nno such page') as unknown,
    });
    expect(await callTool(webFetch, { url: 'file:///etc/passwd' }, ctx)).toMatchObject({
      isError: true,
      output: 'web_fetch reads http and https pages only, not file: addresses.',
    });
  });

  it('asks per host, so a rule or an approval can cover one site', () => {
    expect(webFetch.subject?.({ url: 'https://docs.python.org/3/' })).toBe('docs.python.org');
  });
});

describe('http_request', () => {
  async function api() {
    const port = await serve((req, res, body) => {
      res.writeHead(req.url === '/v1/missing' ? 404 : 200, {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '41',
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          extra: req.headers['x-extra'],
          type: req.headers['content-type'],
          body,
        }),
      );
    });
    return `http://127.0.0.1:${port}`;
  }

  it('calls a configured API with its headers, which the model cannot replace', async () => {
    const base = await api();
    const tool = httpRequestTool(
      { [`${base}/v1`]: { headers: { Authorization: env('API_TOKEN') }, description: 'Test API' } },
      { API_TOKEN: 'Bearer secret' },
    );
    const ctx = await context();

    const { output, isError } = await callTool(
      tool,
      {
        method: 'POST',
        url: `${base}/v1/items?x=1`,
        headers: { Authorization: 'Bearer stolen', 'X-Extra': 'yes' },
        json: { name: 'a' },
      },
      ctx,
    );

    expect(isError).toBe(false);
    expect(output).toMatch(
      /^HTTP 200 OK\ncontent-type: application\/json\nx-ratelimit-remaining: 41\n\n/,
    );
    expect(JSON.parse(output.split('\n\n')[1]!)).toEqual({
      method: 'POST',
      url: '/v1/items?x=1',
      auth: 'Bearer secret',
      extra: 'yes',
      type: 'application/json',
      body: '{"name":"a"}',
    });
    expect(tool.description).toContain(`- ${base}/v1/: Test API`);
    expect(tool.description).not.toContain('secret');
  });

  it('refuses URLs outside the configured APIs and reports HTTP errors', async () => {
    const base = await api();
    const tool = httpRequestTool({ [`${base}/v1`]: {} }, {});
    const ctx = await context();

    for (const url of [
      `${base}/v2/items`,
      `${base}/v1x`,
      `${base}/v1/../admin`,
      'https://example.com/v1',
    ]) {
      expect(await callTool(tool, { url }, ctx)).toMatchObject({
        isError: true,
        output: expect.stringContaining('is not under any configured API') as unknown,
      });
    }
    expect((await callTool(tool, { url: `${base}/v1` }, ctx)).isError).toBe(false);
    expect((await callTool(tool, { url: `${base}/v1/missing` }, ctx)).output).toMatch(
      /^HTTP 404 Not Found/,
    );
    expect(tool.subject?.({ method: 'GET', url: `${base}/v1/items` })).toBe(`GET ${base}`);
  });

  it('is offered only when APIs are configured, and the config checks their URLs', async () => {
    const model = new ScriptedModelClient([]);
    const without = await createEngine({ model, toolsets: ['http'] });
    const withApis = await createEngine({
      model,
      toolsets: ['http'],
      http: { apis: { 'https://api.example.com': {} } },
    });

    expect(without.tools.map((tool) => tool.name)).toEqual([]);
    expect(withApis.tools.map((tool) => tool.name)).toEqual(['http_request']);
    expect(() => validateConfig({ http: { apis: { 'not a url': {} } } }, 'heaw.config.ts')).toThrow(
      'expected a base URL such as https://api.example.com',
    );
    expect(
      validateConfig(
        { http: { apis: { 'https://api.example.com/v1': { headers: { A: env('X') } } } } },
        'f',
      ),
    ).toBeTruthy();
  });
});

describe('todo_write', () => {
  const todos = [
    { content: 'Read the parser', status: 'completed' },
    { content: 'Add tests', status: 'in_progress' },
    { content: 'Fix the bug', status: 'pending' },
  ] as const;

  it('keeps the list in the session and reports progress', async () => {
    const ctx = await context();

    expect((await callTool(todoWrite, { todos }, ctx)).output).toBe(
      'Task list saved: 1 of 3 done. In progress: Add tests.',
    );
    expect(ctx.state.get(TODO_STATE)).toEqual(todos);
    const done = todos.map((todo) => ({ ...todo, status: 'completed' }));
    expect((await callTool(todoWrite, { todos: done }, ctx)).output).toBe('All 3 tasks are done.');
  });

  it('shows the list in the chat, live and after a resume', () => {
    const live = transcriptReducer(createTranscript(emptyUsage()), {
      type: 'event',
      event: {
        ...EVENT_BASE,
        type: 'tool.start',
        callId: 't1',
        tool: 'todo_write',
        args: { todos },
      },
    });
    expect(live.items.at(-1)).toMatchObject({ kind: 'tool', todos });

    const resumed = itemsFromHistory([
      { role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 't1', name: 'todo_write', args: { todos } }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', callId: 't1', name: 'todo_write', output: 'saved' }],
      },
    ]);
    expect(resumed.at(-1)).toMatchObject({ kind: 'tool', status: 'ok', todos });
  });

  it('is part of the default tools', async () => {
    const engine = await createEngine({ model: new ScriptedModelClient([{ text: 'ok' }]) });
    await collect(engine.session().send('hi'));
    expect(engine.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['web_fetch', 'todo_write']),
    );
    await engine.dispose();
  });
});
