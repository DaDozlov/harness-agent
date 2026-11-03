import { NodeHtmlMarkdown } from 'node-html-markdown';
import { z } from 'zod';
import type { ToolOutput } from '../core/tools.js';
import { VERSION } from '../version.js';
import { defineTool } from './define.js';

const DEFAULT_LENGTH = 20_000;
const MAX_BYTES = 5_000_000;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/** Page parts that are not content. */
const converter = new NodeHtmlMarkdown({
  ignore: ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'nav', 'footer'],
  maxConsecutiveNewlines: 2,
});

export const webFetch = defineTool({
  name: 'web_fetch',
  description:
    'Fetch a web page and return its content as Markdown; JSON and plain text come back as ' +
    'they are. Use it for documentation, issues and articles. Long pages come in parts: pass ' +
    'start_index to read on. Links stay as the page wrote them, relative to the URL shown. A ' +
    'redirect to another host is reported instead of followed: fetch the new address if it ' +
    'looks right.',
  kind: 'network',
  parameters: z.object({
    url: z.string().describe('The address, starting with https:// or http://'),
    start_index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Character to start from, to read on in a long page (default 0)'),
    max_length: z
      .number()
      .int()
      .min(1_000)
      .max(100_000)
      .optional()
      .describe(`Characters to return (default ${DEFAULT_LENGTH})`),
  }),
  subject: (args) => hostnameOf(args.url),
  async run({ url, start_index = 0, max_length = DEFAULT_LENGTH }, { signal }) {
    const target = parseUrl(url);
    if (typeof target === 'string') return { output: target, isError: true };

    const fetched = await fetchFollowingSameHost(target, signal);
    if ('redirect' in fetched) {
      return `${target.href} redirects to another host: ${fetched.redirect.href}\nFetch that address if it is the page you want.`;
    }
    const { response, url: finalUrl } = fetched;
    const page = await readPage(response);
    const status = response.ok ? '' : `HTTP ${response.status} ${response.statusText}\n`;
    const header = `URL: ${finalUrl.href}\n${page.title ? `Title: ${page.title}\n` : ''}${status}`;
    return {
      output: `${header}\n${slice(page.text, start_index, max_length)}`,
      isError: !response.ok,
    } satisfies ToolOutput;
  },
});

export const WEB_TOOLS = [webFetch];

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function parseUrl(url: string): URL | string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a valid URL. Use a full address such as https://example.com/page.`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `web_fetch reads http and https pages only, not ${parsed.protocol} addresses.`;
  }
  return parsed;
}

/** Follows redirects within the host that was approved; another host has to be fetched itself. */
async function fetchFollowingSameHost(
  url: URL,
  signal: AbortSignal,
): Promise<{ response: Response; url: URL } | { redirect: URL }> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: {
        'user-agent': `heaw/${VERSION}`,
        accept: 'text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, url: current };
    }
    await response.body?.cancel();
    const next = new URL(location, current);
    if (next.hostname !== url.hostname) return { redirect: next };
    current = next;
  }
  throw new Error(`${url.href} redirected more than ${MAX_REDIRECTS} times.`);
}

/** The page as text: HTML as Markdown, other text as it is. */
async function readPage(response: Response): Promise<{ text: string; title?: string }> {
  const type = response.headers.get('content-type') ?? '';
  const { bytes, complete } = await readLimited(response, MAX_BYTES);
  const cut = complete
    ? ''
    : `\n\n[The page is larger than ${MAX_BYTES / 1_000_000} MB; the rest was not read.]`;
  if (!isText(type)) {
    return {
      text: `[${type || 'unknown content type'}, ${bytes.length} bytes: not text, so not shown]`,
    };
  }
  const raw = decode(bytes, type);
  if (!/html|xml/i.test(type) || /^\s*[{[]/.test(raw)) return { text: raw + cut };
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g, ' ').trim();
  const markdown = converter.translate(raw).trim();
  return { text: markdown + cut, ...(title && { title }) };
}

function isText(type: string): boolean {
  return !type || /^text\/|json|xml|javascript|ecmascript|yaml|csv|markdown/i.test(type);
}

async function readLimited(
  response: Response,
  limit: number,
): Promise<{ bytes: Buffer; complete: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Node types the body as a stream of `any`; fetch bodies are bytes.
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), complete: true };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks).subarray(0, limit), complete: false };
    }
  }
  return { bytes: Buffer.concat(chunks), complete: true };
}

function decode(bytes: Buffer, type: string): string {
  const charset = /charset="?([\w-]+)/i.exec(type)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Part of a long page, saying how to read on. */
function slice(text: string, start: number, length: number): string {
  if (start > 0 && start >= text.length) {
    return `[Nothing at start_index ${start}: the page has ${text.length} characters.]`;
  }
  const end = Math.min(text.length, start + length);
  const part = text.slice(start, end);
  if (start === 0 && end === text.length) return part;
  const more = end < text.length ? ` To read on, call web_fetch with start_index ${end}.` : '';
  return `${part}\n\n[Characters ${start}–${end} of ${text.length}.${more}]`;
}
