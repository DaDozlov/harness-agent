export interface InstructionFile {
  /** Shown to the model, e.g. `AGENTS.md`. */
  source: string;
  text: string;
}

/** The instruction layer of the system prompt (docs/DESIGN.md §4.6), most general first. */
export function formatInstructions(files: readonly InstructionFile[]): string | undefined {
  if (!files.length) return undefined;
  return [
    'The user and the project gave these instructions. Follow them. Where they conflict, later ' +
      "files win over earlier ones, and the user's messages win over all of them.",
    ...files.map((file) => `<instructions source="${file.source}">\n${file.text}\n</instructions>`),
  ].join('\n\n');
}
