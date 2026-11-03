/** The prompt's text and cursor. Pure functions, so editing is easy to test. */
export interface InputBuffer {
  text: string;
  /** Offset into `text`, 0 … text.length. */
  cursor: number;
}

export const EMPTY_INPUT: InputBuffer = { text: '', cursor: 0 };

export function fromText(text: string): InputBuffer {
  return { text, cursor: text.length };
}

export function insert(buffer: InputBuffer, text: string): InputBuffer {
  const clean = text.replace(/\r\n?/g, '\n');
  return {
    text: buffer.text.slice(0, buffer.cursor) + clean + buffer.text.slice(buffer.cursor),
    cursor: buffer.cursor + clean.length,
  };
}

export function deleteBackward(buffer: InputBuffer): InputBuffer {
  if (buffer.cursor === 0) return buffer;
  return {
    text: buffer.text.slice(0, buffer.cursor - 1) + buffer.text.slice(buffer.cursor),
    cursor: buffer.cursor - 1,
  };
}

export function deleteForward(buffer: InputBuffer): InputBuffer {
  if (buffer.cursor === buffer.text.length) return buffer;
  return {
    ...buffer,
    text: buffer.text.slice(0, buffer.cursor) + buffer.text.slice(buffer.cursor + 1),
  };
}

/** Ctrl+W: deletes the word before the cursor. */
export function deleteWordBackward(buffer: InputBuffer): InputBuffer {
  const before = buffer.text.slice(0, buffer.cursor);
  const start = before.replace(/\S+\s*$/, '').length;
  return { text: buffer.text.slice(0, start) + buffer.text.slice(buffer.cursor), cursor: start };
}

/** Ctrl+U: deletes from the start of the line to the cursor. */
export function deleteToLineStart(buffer: InputBuffer): InputBuffer {
  const start = lineStart(buffer);
  return { text: buffer.text.slice(0, start) + buffer.text.slice(buffer.cursor), cursor: start };
}

export function moveLeft(buffer: InputBuffer): InputBuffer {
  return { ...buffer, cursor: Math.max(0, buffer.cursor - 1) };
}

export function moveRight(buffer: InputBuffer): InputBuffer {
  return { ...buffer, cursor: Math.min(buffer.text.length, buffer.cursor + 1) };
}

export function moveLineStart(buffer: InputBuffer): InputBuffer {
  return { ...buffer, cursor: lineStart(buffer) };
}

export function moveLineEnd(buffer: InputBuffer): InputBuffer {
  const end = buffer.text.indexOf('\n', buffer.cursor);
  return { ...buffer, cursor: end === -1 ? buffer.text.length : end };
}

export function isOnFirstLine(buffer: InputBuffer): boolean {
  return !buffer.text.slice(0, buffer.cursor).includes('\n');
}

export function isOnLastLine(buffer: InputBuffer): boolean {
  return !buffer.text.slice(buffer.cursor).includes('\n');
}

function lineStart(buffer: InputBuffer): number {
  return buffer.text.lastIndexOf('\n', buffer.cursor - 1) + 1;
}
