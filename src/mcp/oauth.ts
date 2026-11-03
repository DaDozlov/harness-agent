import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  auth,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type { Env } from '../providers/registry.js';
import { expandValue, isHttpServer, type McpServerEntry } from './config.js';

/** What heaw keeps after logging in to one MCP server. */
export interface McpLogin {
  serverUrl: string;
  /** The loopback address the client was registered with, reused by the next login. */
  redirectUrl?: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}

/**
 * Logins to MCP servers: one file per server URL in `dir` (normally ~/.heaw/credentials/mcp),
 * readable only by the user. Keyed by URL, so projects that use the same server share a login.
 */
export class McpCredentialStore {
  constructor(readonly dir: string) {}

  fileFor(serverUrl: string): string {
    const url = new URL(serverUrl);
    const hash = createHash('sha256').update(url.href).digest('hex').slice(0, 12);
    return join(this.dir, `${url.hostname.replace(/[^\w.-]/g, '_')}-${hash}.json`);
  }

  /** The saved login, or undefined when there is none (or the file is unreadable). */
  async read(serverUrl: string): Promise<McpLogin | undefined> {
    try {
      const login = JSON.parse(await readFile(this.fileFor(serverUrl), 'utf8')) as McpLogin;
      return login.serverUrl === new URL(serverUrl).href ? login : undefined;
    } catch {
      return undefined;
    }
  }

  async write(login: McpLogin): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(login.serverUrl);
    await writeFile(file, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
    // The mode above only applies to new files.
    await chmod(file, 0o600);
  }

  /** Forgets the login; false when there was none. */
  async remove(serverUrl: string): Promise<boolean> {
    try {
      await rm(this.fileFor(serverUrl));
      return true;
    } catch {
      return false;
    }
  }
}

/** Client settings from `"oauth": { … }` in the server's config, with secrets resolved. */
export interface McpOAuthSettings {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  /** A fixed port for the login callback, for clients registered in advance. */
  callbackPort?: number;
}

/** Where logins are kept, relative to the heaw home folder (`~/.heaw`). */
export const MCP_CREDENTIALS_DIR = join('credentials', 'mcp');

/** The OAuth settings in a server's config, with the client secret read from the environment. */
export function oauthSettingsOf(entry: McpServerEntry, env: Env): McpOAuthSettings {
  const oauth = isHttpServer(entry.config) ? entry.config.oauth : undefined;
  if (typeof oauth !== 'object') return {};
  const where = `mcpServers.${entry.name}.oauth.clientSecret`;
  return {
    ...(oauth.clientId && { clientId: oauth.clientId }),
    ...(oauth.clientSecret !== undefined && {
      clientSecret: expandValue(oauth.clientSecret, env, where),
    }),
    ...(oauth.scopes && { scopes: oauth.scopes }),
    ...(oauth.callbackPort && { callbackPort: oauth.callbackPort }),
  };
}

/** Why heaw cannot log in to this server, or undefined when it can. */
export function loginProblem(entry: McpServerEntry): string | undefined {
  if (!isHttpServer(entry.config)) {
    return `"${entry.name}" is a local server; logins are for remote servers.`;
  }
  if (!entry.config.oauth) {
    return `"${entry.name}" is not set up for a login: add "oauth": true to it in ${entry.source}.`;
  }
  return undefined;
}

/** Used for connecting, when no login is running; the SDK needs some address to call it interactive. */
const PLACEHOLDER_REDIRECT = 'http://127.0.0.1/callback';
const CALLBACK_PATH = '/callback';

/**
 * OAuth for one MCP server, as the MCP SDK wants it: the SDK does discovery, dynamic client
 * registration, PKCE and refreshing; this class keeps the results. Without `login`, it only uses
 * a saved login: whatever needs the browser fails with UnauthorizedError, so connecting never
 * registers clients or opens pages.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly #store: McpCredentialStore;
  readonly #serverUrl: string;
  readonly #settings: McpOAuthSettings;
  readonly #login:
    { redirectUrl: string; onAuthorizationUrl: (url: URL) => void | Promise<void> } | undefined;
  readonly #state = randomBytes(16).toString('base64url');
  #record: Promise<McpLogin> | undefined;
  #savedRedirect: string | undefined;
  #verifier: string | undefined;
  #discovery: OAuthDiscoveryState | undefined;

  constructor(
    store: McpCredentialStore,
    serverUrl: string,
    settings: McpOAuthSettings = {},
    login?: { redirectUrl: string; onAuthorizationUrl: (url: URL) => void | Promise<void> },
  ) {
    this.#store = store;
    this.#serverUrl = new URL(serverUrl).href;
    this.#settings = settings;
    this.#login = login;
  }

  get redirectUrl(): string {
    return this.#login?.redirectUrl ?? this.#savedRedirect ?? PLACEHOLDER_REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'heaw',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.#settings.clientSecret ? 'client_secret_post' : 'none',
      ...(this.#settings.scopes?.length && { scope: this.#settings.scopes.join(' ') }),
    };
  }

  state(): string {
    return this.#state;
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const { clientId, clientSecret } = this.#settings;
    if (clientId)
      return { client_id: clientId, ...(clientSecret && { client_secret: clientSecret }) };
    const { client } = await this.#load();
    // Registering a client is part of logging in, never of connecting.
    if (!client && !this.#login) throw new UnauthorizedError('Not logged in.');
    return client;
  }

  async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    // A client from the config stays there.
    if (this.#settings.clientId) return;
    await this.#update((record) => {
      record.client = client;
    });
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.#load()).tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.#update((record) => {
      record.tokens = tokens;
      if (this.#login) record.redirectUrl = this.#login.redirectUrl;
    });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.#login) throw new UnauthorizedError('The login has expired.');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error(`The server sent an unsafe login address: ${url.href}`);
    }
    await this.#login.onAuthorizationUrl(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.#verifier) throw new Error('No login is in progress.');
    return this.#verifier;
  }

  // Kept for the length of one login: the callback leg checks it against the first.
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'verifier' || scope === 'all') this.#verifier = undefined;
    if (scope === 'discovery' || scope === 'all') this.#discovery = undefined;
    if (scope === 'verifier' || scope === 'discovery') return;
    await this.#update((record) => {
      if (scope !== 'tokens') delete record.client;
      delete record.tokens;
    });
  }

  #load(): Promise<McpLogin> {
    this.#record ??= this.#store.read(this.#serverUrl).then((saved) => {
      this.#savedRedirect = saved?.redirectUrl;
      // A client registered for another callback address cannot finish this login.
      if (this.#login && saved?.redirectUrl !== this.#login.redirectUrl) {
        return { serverUrl: this.#serverUrl, redirectUrl: this.#login.redirectUrl };
      }
      return saved ?? { serverUrl: this.#serverUrl };
    });
    return this.#record;
  }

  async #update(change: (record: McpLogin) => void): Promise<void> {
    const record = await this.#load();
    change(record);
    await this.#store.write(record);
  }
}

export interface McpLoginOptions {
  store: McpCredentialStore;
  serverUrl: string;
  settings?: McpOAuthSettings;
  /** Shows the login page, e.g. opens it in the browser and prints it. */
  onAuthorizationUrl: (url: URL) => void | Promise<void>;
  signal?: AbortSignal;
  /** How long to wait for the browser to come back. Default: 5 minutes. */
  timeoutMs?: number;
  fetch?: FetchLike;
}

/**
 * Logs in to an MCP server: the browser opens the server's login page, which sends it back to
 * a short-lived server on 127.0.0.1; the tokens are saved in the store.
 */
export async function loginToMcpServer(options: McpLoginOptions): Promise<void> {
  const { store, serverUrl, settings = {} } = options;
  const saved = await store.read(serverUrl);
  const fixed = settings.callbackPort;
  const callback = await listenForCallback(
    fixed ?? portOf(saved?.redirectUrl),
    fixed !== undefined,
  );
  try {
    const provider = new McpOAuthProvider(store, serverUrl, settings, {
      redirectUrl: callback.redirectUrl,
      onAuthorizationUrl: options.onAuthorizationUrl,
    });
    const common = {
      serverUrl,
      ...(settings.scopes?.length && { scope: settings.scopes.join(' ') }),
      ...(options.fetch && { fetchFn: options.fetch }),
    };
    // Listening first: the browser may come back before auth() returns.
    const answer = callback.wait(provider.state(), {
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      ...(options.signal && { signal: options.signal }),
    });
    answer.catch(() => undefined);
    // A login is asked for on purpose, so saved tokens are not simply refreshed.
    if ((await auth(provider, { ...common, forceReauthorization: true })) === 'AUTHORIZED') return;
    const { code, iss } = await answer;
    await auth(provider, { ...common, authorizationCode: code, ...(iss && { iss }) });
  } finally {
    await callback.close();
  }
}

function portOf(url: string | undefined): number | undefined {
  return url ? Number(new URL(url).port) || undefined : undefined;
}

interface Callback {
  redirectUrl: string;
  wait(
    state: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ code: string; iss: string | undefined }>;
  close(): Promise<void>;
}

/**
 * Listens on 127.0.0.1 for the browser's return from the login page. Tries `port` first, so the
 * registered address stays valid; a port in use falls back to a free one unless it is `fixed`.
 */
async function listenForCallback(port: number | undefined, fixed: boolean): Promise<Callback> {
  let pending:
    { answer: (params: URLSearchParams) => string; cancel: (reason: Error) => void } | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const message =
      pending?.answer(url.searchParams) ?? 'heaw is not waiting for a login right now.';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(message));
  });

  let actual: number;
  try {
    actual = await listen(server, port ?? 0);
  } catch (error) {
    if (fixed || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw new Error(
        `Cannot listen for the login on port ${port ?? 0}: ${(error as Error).message}` +
          (fixed ? ' Free the port, or change "callbackPort".' : ''),
        { cause: error },
      );
    }
    actual = await listen(server, 0);
  }

  return {
    redirectUrl: `http://127.0.0.1:${actual}${CALLBACK_PATH}`,
    wait: (state, { timeoutMs, signal }) =>
      new Promise((resolve, reject) => {
        const finish = (outcome: () => void) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          pending = undefined;
          outcome();
        };
        const fail = (reason: Error) => finish(() => reject(reason));
        const timer = setTimeout(
          () => fail(new Error(`No login within ${describeDuration(timeoutMs)}.`)),
          timeoutMs,
        );
        const onAbort = () => fail(new Error('The login was cancelled.'));
        signal?.addEventListener('abort', onAbort, { once: true });
        pending = {
          cancel: fail,
          answer: (params) => {
            // Another page may call this address; only the login heaw started counts.
            if (params.get('state') !== state) {
              return 'This page is not from the login heaw started. Start the login again.';
            }
            const code = params.get('code');
            if (!code) {
              const reason =
                params.get('error_description') ?? params.get('error') ?? 'no authorization code';
              fail(new Error(`The login failed: ${reason}`));
              return `The login failed: ${reason}. You can close this tab.`;
            }
            finish(() => resolve({ code, iss: params.get('iss') ?? undefined }));
            return 'Logged in. You can close this tab and return to heaw.';
          },
        };
      }),
    close: () => {
      pending?.cancel(new Error('The login was stopped.'));
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function describeDuration(ms: number): string {
  return ms >= 60_000 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function page(message: string): string {
  const text = message.replace(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>heaw</title><p style="font: 16px system-ui; margin: 3em">${text}</p>`;
}
