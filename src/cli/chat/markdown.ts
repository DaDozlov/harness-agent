import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const marked = new Marked(
  // Ink wraps lines itself, so marked-terminal must not reflow them as well.
  markedTerminal({ reflowText: false, tab: 2, emoji: false }) as Parameters<Marked['use']>[0],
);

/** Renders Markdown for the terminal: headings, emphasis, code blocks, lists, tables, links. */
export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false }).replace(/\n+$/, '');
  } catch {
    // Half-streamed Markdown can be odd; showing the raw text beats showing nothing.
    return text;
  }
}
