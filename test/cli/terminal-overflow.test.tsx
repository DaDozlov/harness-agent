import { EventEmitter } from 'node:events';
import { Terminal } from '@xterm/headless';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/cli/chat/App.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';

/**
 * Renders the chat into an emulated 80x15 terminal and checks the scrollback. Ink cannot erase
 * live-area lines that scrolled off screen, so a live area taller than the terminal prints a new
 * copy on every update; the test harness used elsewhere has no screen height and cannot see it.
 */

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TerminalOutput extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 15;
  constructor(private readonly terminal: Terminal) {
    super();
  }
  write(data: string, callback?: () => void): boolean {
    this.terminal.write(data);
    callback?.();
    return true;
  }
}

class TerminalInput extends EventEmitter {
  readonly isTTY = true;
  readonly #queue: string[] = [];
  setRawMode() {
    return this;
  }
  setEncoding() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read(): string | null {
    return this.#queue.shift() ?? null;
  }
  type(data: string) {
    this.#queue.push(data);
    this.emit('readable');
  }
}

/** Streams `answer` in the chat and returns the terminal's scrollback and screen, line by line. */
async function streamIntoTerminal(answer: string): Promise<string[]> {
  // convertEol: a real terminal driver turns "\n" into a new line at column 0.
  const terminal = new Terminal({
    cols: 80,
    rows: 15,
    scrollback: 5_000,
    allowProposedApi: true,
    convertEol: true,
  });
  const stdout = new TerminalOutput(terminal);
  const stdin = new TerminalInput();
  const engine = await createEngine({
    model: new ScriptedModelClient([{ text: answer, chunkSize: 12, chunkDelayMs: 2 }]),
    toolsets: [],
  });
  const session = engine.session();
  const app = render(<App engine={engine} session={session} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await tick(100);
  stdin.type('go');
  await tick(20);
  stdin.type('\r');
  await tick(50);
  while (session.running) await tick(20);
  await tick(200);
  app.unmount();
  await new Promise<void>((resolve) => terminal.write('', resolve));

  const lines: string[] = [];
  for (let index = 0; index < terminal.buffer.active.length; index++) {
    lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? '');
  }
  return lines;
}

const numbered = (count: number, line: (n: string) => string) =>
  Array.from({ length: count }, (_, index) => line(String(index + 1).padStart(2, '0')));

describe('long answers in a small terminal', () => {
  it('prints each paragraph exactly once', { timeout: 30_000 }, async () => {
    const paragraphs = numbered(40, (n) => `Paragraph ${n} of the answer.`);

    const lines = await streamIntoTerminal(paragraphs.join('\n\n'));

    const counts = paragraphs.map(
      (paragraph) => lines.filter((line) => line.includes(paragraph)).length,
    );
    expect(counts).toEqual(paragraphs.map(() => 1));
  });

  it('prints a long block without blank lines exactly once', { timeout: 30_000 }, async () => {
    const items = numbered(40, (n) => `List item ${n} of the answer`);

    const lines = await streamIntoTerminal(items.map((item) => `- ${item}`).join('\n'));

    const counts = items.map((item) => lines.filter((line) => line.includes(item)).length);
    expect(counts).toEqual(items.map(() => 1));
  });
});
