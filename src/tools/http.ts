import { z } from 'zod';
import type { Tool } from '../core/tools.js';
import { type Env } from '../providers/registry.js';
import { resolveSetting, type Setting } from '../providers/settings.js';
import { VERSION } from '../version.js';
import { defineTool } from './define.js';

/** One API the agent may call, by base URL (docs/DESIGN.md §4.4). */
export interface HttpApi {
  /** Sent with every request, e.g. `{ Authorization: env('API_TOKEN') }`. The model never sees them. */
  headers?: Record<string, Setting>;
  /** What the API is for, shown to the model. */
  description?: string;
}

const TIMEOUT_MS = 60_000;
const MAX_BYTES = 2_000_000;
/** Response headers worth showing; the rest is noise for the model. */
const SHOWN_HEADERS = ['content-type', 'location', 'link', 'retry-after', 'x-ratelimit-remaining'];

/**
 * `http_request` for the APIs in `http.apis`: only URLs under one of their base URLs, with the
 * API's headers added. Secrets stay in the config, so the model can call an API without seeing
 * its token.
 */
export function httpRequestTool(apis: Record<string, HttpApi>, env: Env): Tool {
  const bases = Object.entries(apis).map(([base, api]) => ({ base: baseUrl(base), api }));
  const listed = bases
    .map(({ base, api }) => `- ${base.href}${api.description ? `: ${api.description}` : ''}`)
    .join('\n');

  return defineTool({
    name: 'http_request',
    description:
      'Call an HTTP API. Only these APIs are available; their authentication is added for you, ' +
      `so do not send credentials:\n${listed}\n` +
      'Returns the status, a few headers and the body.',
    kind: 'network',
    parameters: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
      url: z.string().describe('The full URL, under one of the APIs above'),
      headers: z.record(z.string(), z.string()).optional().describe('Extra request headers'),
      json: z.unknown().optional().describe('A JSON body; sets content-type to application/json'),
      body: z.string().optional().describe('A text body, when the API does not take JSON'),
    }),
    // Method and origin: an approval for the session covers, say, every GET to one API.
    subject: ({ method, url }) => `${method} ${originOf(url)}`,
    async run({ method, url, headers, json, body }, { signal }) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return { output: `"${url}" is not a valid URL.`, isError: true };
      }
      const match = bases.find(({ base }) => isUnder(target, base));
      if (!match) {
        return {
          output: `${target.href} is not under any configured API. Available:\n${listed}`,
          isError: true,
        };
      }
      const configured = Object.fromEntries(
        Object.entries(match.api.headers ?? {}).map(([name, value]) => [
          name,
          resolveSetting(value, env, `http.apis["${match.base.href}"].headers.${name}`) ?? '',
        ]),
      );
      const response = await fetch(target, {
        method,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        headers: {
          'user-agent': `heaw/${VERSION}`,
          ...(json !== undefined && { 'content-type': 'application/json' }),
          ...headers,
          // The configured headers win, so the model cannot replace the credentials.
          ...configured,
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : body !== undefined && { body }),
      });
      const text = await readText(response);
      const shown = SHOWN_HEADERS.flatMap((name) => {
        const value = response.headers.get(name);
        return value ? [`${name}: ${value}`] : [];
      });
      return {
        output: [`HTTP ${response.status} ${response.statusText}`, ...shown, '', text].join('\n'),
        isError: response.status >= 400,
      };
    },
  });
}

function baseUrl(base: string): URL {
  const url = new URL(base);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

/** `base` ends with a slash; the base itself counts with or without one. */
function isUnder(url: URL, base: URL): boolean {
  return url.origin === base.origin && `${url.pathname}/`.startsWith(base.pathname);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function readText(response: Response): Promise<string> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') ?? '';
  if (type && !/^text\/|json|xml|javascript|yaml|csv|x-www-form-urlencoded/i.test(type)) {
    return `[${type}, ${bytes.length} bytes: not text, so not shown]`;
  }
  const text = bytes.subarray(0, MAX_BYTES).toString('utf8');
  return bytes.length > MAX_BYTES
    ? `${text}\n[The body is larger than 2 MB; the rest was cut.]`
    : text;
}
