/**
 * The classic Windows console lacks glyphs such as braille spinners; Windows Terminal and the
 * VS Code terminal have them. Elsewhere, Unicode is safe.
 */
const unicode =
  process.platform !== 'win32' ||
  Boolean(process.env.WT_SESSION) ||
  process.env.TERM_PROGRAM === 'vscode';

export const glyphs = unicode
  ? {
      prompt: '❯',
      pointer: '❯',
      bullet: '●',
      branch: '⎿',
      spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      border: 'round' as const,
      todo: '☐',
      todoActive: '▶',
      todoDone: '☑',
    }
  : {
      prompt: '>',
      pointer: '>',
      bullet: '*',
      branch: ' ',
      spinner: ['|', '/', '-', '\\'],
      border: 'single' as const,
      todo: '[ ]',
      todoActive: '[>]',
      todoDone: '[x]',
    };

export const MODE_COLORS = {
  default: 'gray',
  'accept-edits': 'magenta',
  'read-only': 'blue',
  bypass: 'red',
} as const;
