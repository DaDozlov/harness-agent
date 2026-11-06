import { Marked, type RendererThis, type Token, type Tokens } from 'marked';
import { markedTerminal } from 'marked-terminal';

/** Indentation of a list in the text around it, as marked-terminal indents other blocks. */
const LIST_INDENT = '  ';

const marked = new Marked(
  // Ink wraps lines itself, so marked-terminal must not reflow them as well.
  markedTerminal({ reflowText: false, tab: 2, emoji: false }) as Parameters<Marked['use']>[0],
  {
    renderer: {
      list(this: RendererThis, token: Tokens.List) {
        return `${indent(LIST_INDENT, renderList(this, token))}\n\n`;
      },
    },
  },
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

/**
 * A list with its nested lists, rendered here rather than by marked-terminal: with colours on, it
 * put colour codes before nested items, so they lost their indentation and left blank lines;
 * without, it counted nested items into the outer numbers; and it showed the inline Markdown of
 * list items (`code`, **bold**) as typed. Numbers start where the text's do, so a list that
 * streams in a paragraph at a time keeps them.
 */
function renderList(renderer: RendererThis, token: Tokens.List): string {
  const start = typeof token.start === 'number' ? token.start : 1;
  const items = token.items.map((item, index) => {
    const marker = token.ordered ? `${start + index}. ` : '* ';
    const parts = item.tokens.map((part) => renderPart(renderer, part).trimEnd());
    // A task's checkbox is a token of its own, shown before the item's text.
    if (item.tokens[0]?.type === 'checkbox' && parts.length > 1) {
      parts.splice(0, 2, `${parts[0]} ${parts[1]}`);
    }
    const body = parts.filter(Boolean).join(item.loose ? '\n\n' : '\n');
    const [first = '', ...rest] = body.split('\n');
    const pad = ' '.repeat(marker.length);
    return [marker + first, ...rest.map((line) => (line ? pad + line : line))].join('\n');
  });
  return items.join(token.loose ? '\n\n' : '\n');
}

function renderPart(renderer: RendererThis, part: Token): string {
  if (part.type === 'list') return renderList(renderer, part as Tokens.List);
  if (part.type === 'text' && 'tokens' in part && part.tokens) {
    return renderer.parser.parseInline(part.tokens);
  }
  return renderer.parser.parse([part]).replace(/\n+$/, '');
}

function indent(prefix: string, text: string): string {
  return text.replace(/^(?=.)/gm, prefix);
}
