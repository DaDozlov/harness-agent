export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 30_000;

/**
 * Shortens text to about `maxChars`, keeping the start and the end: command output often ends
 * with the part that matters (errors, summaries). `note` explains what happened to the rest.
 */
export function truncateMiddle(
  text: string,
  maxChars: number,
  note: (omittedChars: number) => string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[${note(omitted)}]\n\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}
