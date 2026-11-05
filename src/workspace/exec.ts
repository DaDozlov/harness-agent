import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ExecResult } from '../core/workspace.js';

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Commands can print gigabytes; keep memory bounded. Output is truncated later anyway. */
export const MAX_CAPTURE_CHARS = 5_000_000;

/** Commands run without a terminal: no prompts, no pagers, no colors. */
export const COMMAND_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  NO_COLOR: '1',
};

/**
 * Collects a started command's output (stdout and stderr interleaved) until it exits. On timeout
 * or abort, `stop` must end it and everything it started; the result then has no exit code.
 */
export function capture(
  child: ChildProcess,
  options: {
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    stop: () => void;
    /** What to say when the process cannot even start. */
    startError: (error: Error) => string;
    onOutput?: ((text: string) => void) | undefined;
  },
): Promise<ExecResult> {
  const started = Date.now();
  const { signal, onOutput } = options;
  return new Promise((resolveResult) => {
    const output = new OutputBuffer(MAX_CAPTURE_CHARS);
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    const append = (text: string) => {
      output.append(text);
      if (text) onOutput?.(stripAnsi(text));
    };
    child.stdout?.on('data', (chunk: Buffer) => append(stdout.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => append(stderr.write(chunk)));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      options.stop();
    }, options.timeoutMs);
    const onAbort = () => options.stop();
    signal?.addEventListener('abort', onAbort, { once: true });

    let settled = false;
    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      append(stdout.end());
      append(stderr.end());
      resolveResult({
        exitCode: timedOut || signal?.aborted ? null : exitCode,
        output: collapseProgress(stripAnsi(output.text)),
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (error) => {
      output.append(`${options.startError(error)}\n`);
      settle(null);
    });
    child.on('close', (code) => settle(code));
    if (signal?.aborted) onAbort();
  });
}

export class OutputBuffer {
  #text = '';
  #full = false;

  constructor(private readonly limit: number) {}

  get text(): string {
    return this.#text;
  }

  append(chunk: string): void {
    if (this.#full || !chunk) return;
    this.#text += chunk;
    if (this.#text.length > this.limit) {
      this.#text = `${this.#text.slice(0, this.limit)}\n[output capture limit reached]`;
      this.#full = true;
    }
  }
}

/**
 * Output as a terminal shows it: progress bars redraw their line after a carriage return, which
 * in captured output repeats the line hundreds of times (Maven downloads, npm installs) and only
 * costs the model tokens. Each line keeps its last version.
 */
export function collapseProgress(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const versions = line.split('\r');
      for (let index = versions.length - 1; index > 0; index--) {
        if (versions[index]!.trim()) return versions[index]!;
      }
      return versions[0]!;
    })
    .join('\n');
}

/** Removes terminal color and cursor codes that some tools print even with NO_COLOR. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching terminal escape codes is the point
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}
