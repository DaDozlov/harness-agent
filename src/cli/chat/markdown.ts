import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const marked = new Marked(
  // Ink wraps lines itself, so marked-terminal must not reflow them as well.
  markedTerminal({ reflowText: false, tab: 2, emoji: false }) as Parameters<Marked['use']>[0],
);

/** Renders Markdown for the terminal: headings, emphasis, code blocks, lists, tables, links. */
export function renderMarkdown(text: string): string {
  try {
    return keepListNumbers(text, marked.parse(text, { async: false }).replace(/\n+$/, ''));
  } catch {
    // Half-streamed Markdown can be odd; showing the raw text beats showing nothing.
    return text;
  }
}

/**
 * Text is rendered a paragraph at a time, so item 2 of a list with blank lines between its items
 * arrives as a list of its own, and marked-terminal numbers every list from 1. Its top-level
 * items (indented by `tab`, two spaces) get the numbers the text gave them.
 */
function keepListNumbers(source: string, rendered: string): string {
  const start = Number(/^ {0,3}(\d{1,9})[.)] /.exec(source)?.[1] ?? 1);
  if (start <= 1) return rendered;
  return rendered.replace(
    /^ {2}(\d+)\. /gm,
    (_match, number: string) => `  ${Number(number) + start - 1}. `,
  );
}
