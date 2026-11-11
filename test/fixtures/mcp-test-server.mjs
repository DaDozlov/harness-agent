// A small MCP server for tests. stdio by default; `http <port>` serves Streamable HTTP.
// With REQUIRE_TOKEN set, HTTP requests need "Authorization: Bearer <REQUIRE_TOKEN>".
// With OAUTH=1, it is also an OAuth authorization server (see oauthServer below).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

function buildServer() {
  const server = new McpServer(
    { name: 'heaw-test-server', version: '1.0.0' },
    { instructions: 'Use echo to repeat text back.' },
  );
  const text = (value) => ({ content: [{ type: 'text', text: value }] });

  server.registerTool(
    'echo',
    {
      // ECHO_DESCRIPTION: a server that changed a tool's description after it was trusted.
      description: process.env.ECHO_DESCRIPTION ?? 'Repeat the given text.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text: value }) => text(`echo: ${value}`),
  );
  server.registerTool(
    'add',
    { description: 'Add two numbers.', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => text(String(a + b)),
  );
  server.registerTool('fail', { description: 'Always fails.' }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'boom' }],
  }));
  server.registerTool(
    'slow',
    { description: 'Waits before answering.', inputSchema: { ms: z.number() } },
    async ({ ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return text('done');
    },
  );
  server.registerTool(
    'env',
    { description: 'Reads an environment variable.', inputSchema: { name: z.string() } },
    async ({ name }) => text(process.env[name] ?? '(unset)'),
  );
  server.registerTool('crash', { description: 'Exits the server process.' }, async () => {
    process.exit(1);
  });
  server.registerTool('picture', { description: 'Returns an image and a caption.' }, async () => ({
    content: [
      {
        type: 'image',
        data: Buffer.from('not really a png').toString('base64'),
        mimeType: 'image/png',
      },
      { type: 'text', text: 'a picture' },
    ],
  }));
  return server;
}

const [mode, port] = process.argv.slice(2);
if (mode === 'http') {
  const required = process.env.REQUIRE_TOKEN;
  const oauth = process.env.OAUTH === '1' ? oauthServer() : undefined;
  createServer(async (req, res) => {
    if (oauth && (await oauth.handle(req, res))) return;
    if (required && req.headers.authorization !== `Bearer ${required}`) {
      res.writeHead(401).end();
      return;
    }
    // Stateless: a fresh server and transport per request.
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(Number(port ?? 0), '127.0.0.1', function () {
    // Port 0 picks a free port; tests read the real one from this line.
    process.stdout.write(`listening ${this.address().port}\n`);
  });
} else {
  await buildServer().connect(new StdioServerTransport());
}

/**
 * With OAUTH=1, the server is also its own OAuth authorization server: metadata discovery,
 * dynamic client registration, authorization codes with PKCE, and refresh tokens. MCP requests
 * need a token it issued. `/test/stats` reports what happened; `POST /test/expire` drops the
 * access tokens, as if they had expired.
 */
function oauthServer() {
  const clients = new Map();
  const codes = new Map();
  const accessTokens = new Set();
  const refreshTokens = new Set();
  const stats = { registrations: 0, authorizations: 0, refreshes: 0 };
  let counter = 0;

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const body = async (req) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    return text;
  };
  const issue = (res) => {
    counter += 1;
    const tokens = { access: `access-${counter}`, refresh: `refresh-${counter}` };
    accessTokens.add(tokens.access);
    refreshTokens.add(tokens.refresh);
    json(res, 200, {
      access_token: tokens.access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: tokens.refresh,
    });
  };

  return {
    async handle(req, res) {
      const base = `http://${req.headers.host}`;
      const url = new URL(req.url, base);
      const path = url.pathname;
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      } else if (path.startsWith('/.well-known/oauth-authorization-server')) {
        json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      } else if (path === '/register' && req.method === 'POST') {
        stats.registrations += 1;
        const metadata = JSON.parse(await body(req));
        const client = { ...metadata, client_id: `client-${stats.registrations}` };
        clients.set(client.client_id, client);
        json(res, 201, client);
      } else if (path === '/authorize') {
        const params = url.searchParams;
        const client = clients.get(params.get('client_id'));
        const redirect = params.get('redirect_uri');
        if (!client || !client.redirect_uris.includes(redirect)) {
          json(res, 400, { error: 'invalid_request' });
          return true;
        }
        const back = new URL(redirect);
        back.searchParams.set('state', params.get('state') ?? '');
        if (process.env.OAUTH_DENY === '1') {
          back.searchParams.set('error', 'access_denied');
          back.searchParams.set('error_description', 'The user said <no>');
        } else {
          const code = `code-${codes.size + 1}`;
          codes.set(code, { challenge: params.get('code_challenge'), redirect });
          back.searchParams.set('code', code);
        }
        res.writeHead(302, { location: back.href }).end();
      } else if (path === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(await body(req));
        if (params.get('grant_type') === 'refresh_token') {
          if (!refreshTokens.delete(params.get('refresh_token'))) {
            json(res, 400, { error: 'invalid_grant' });
            return true;
          }
          stats.refreshes += 1;
          issue(res);
          return true;
        }
        const code = codes.get(params.get('code'));
        codes.delete(params.get('code'));
        const verifier = params.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!code || code.challenge !== challenge || code.redirect !== params.get('redirect_uri')) {
          json(res, 400, { error: 'invalid_grant' });
          return true;
        }
        stats.authorizations += 1;
        issue(res);
      } else if (path === '/test/stats') {
        json(res, 200, stats);
      } else if (path === '/test/expire' && req.method === 'POST') {
        accessTokens.clear();
        json(res, 200, {});
      } else {
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        if (accessTokens.has(token)) return false;
        res
          .writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
      }
      return true;
    },
  };
}
