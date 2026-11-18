/**
 * Characters that change what a text says without showing (docs/DESIGN.md §8): zero-width
 * spaces and joiners used to split words a filter looks for, bidirectional controls that make
 * text read differently than it displays, and Unicode tag characters, which can spell out a
 * whole hidden instruction. The model reads them; the user reviewing `AGENTS.md` does not see
 * them. ECC's CI fails on the same set in its prompts and skills.
 */
const KINDS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'zero-width', pattern: /[\u200B\u200C\u2060-\u2064\uFEFF]/gu },
  { name: 'bidirectional control', pattern: /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/gu },
  { name: 'Unicode tag', pattern: /[\u{E0000}-\u{E007F}]/gu },
];

/**
 * What a text hides, e.g. `3 Unicode tag characters (first on line 12)`, or undefined. A byte
 * order mark at the very start is how some editors save files, and is not counted.
 */
export function invisibleCharacters(text: string): string | undefined {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const found: string[] = [];
  let first: number | undefined;
  for (const { name, pattern } of KINDS) {
    const hits = [...body.matchAll(pattern)];
    if (!hits.length) continue;
    found.push(`${hits.length} ${name} character${hits.length === 1 ? '' : 's'}`);
    const at = hits[0]!.index;
    if (first === undefined || at < first) first = at;
  }
  if (!found.length || first === undefined) return undefined;
  const line = body.slice(0, first).split('\n').length;
  return `${found.join(', ')} (first on line ${line})`;
}

/** Warnings for the files of `texts` that hide characters. */
export function invisibleWarnings(texts: Array<{ source: string; text: string }>): string[] {
  return texts.flatMap(({ source, text }) => {
    const found = invisibleCharacters(text);
    return found
      ? [
          `${source} contains ${found}: text the agent reads but you do not see. Remove them ` +
            'unless you put them there on purpose.',
        ]
      : [];
  });
}
