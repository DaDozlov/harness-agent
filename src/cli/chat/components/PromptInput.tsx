import { Box, Text } from 'ink';
import {
  deleteBackward,
  deleteForward,
  deleteToLineStart,
  deleteWordBackward,
  type InputBuffer,
  insert,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
} from '../input-buffer.js';
import { useKeys } from '../keyboard.js';
import { glyphs } from '../theme.js';

export interface PromptInputProps {
  buffer: InputBuffer;
  /** Applies an edit to the latest buffer (keys can arrive faster than renders). */
  edit: (update: (buffer: InputBuffer) => InputBuffer) => void;
  onEnter: () => void;
  onHistory?: (direction: -1 | 1) => void;
  onTab?: () => void;
  isActive: boolean;
  placeholder?: string;
}

/**
 * A multi-line text input. Editing keys are handled here; Enter, history and Tab are passed up.
 * Ctrl+C, Esc and Shift+Tab are left to the chat.
 */
export function PromptInput({
  buffer,
  edit,
  onEnter,
  onHistory,
  onTab,
  isActive,
  placeholder,
}: PromptInputProps) {
  useKeys(
    (input, key) => {
      if ((key.ctrl && input === 'c') || key.escape || (key.shift && key.tab)) return;
      if (key.return) return onEnter();
      if (key.tab) return onTab?.();
      if (key.upArrow) return onHistory?.(-1);
      if (key.downArrow) return onHistory?.(1);
      if (key.leftArrow) return edit(moveLeft);
      if (key.rightArrow) return edit(moveRight);
      if (key.backspace) return edit(deleteBackward);
      if (key.delete) return edit(deleteForward);
      if (key.home || (key.ctrl && input === 'a')) return edit(moveLineStart);
      if (key.end || (key.ctrl && input === 'e')) return edit(moveLineEnd);
      if (key.ctrl && input === 'u') return edit(deleteToLineStart);
      if (key.ctrl && input === 'w') return edit(deleteWordBackward);
      if (key.ctrl || key.meta || !input) return;
      edit((current) => insert(current, input));
    },
    { isActive, onPaste: (text) => edit((current) => insert(current, text)) },
  );

  if (!buffer.text && placeholder) {
    return (
      <Box>
        <Text color="cyan">{glyphs.prompt} </Text>
        {isActive ? <Text inverse> </Text> : null}
        <Text dimColor>{placeholder}</Text>
      </Box>
    );
  }

  const lines = buffer.text.split('\n');
  const starts: number[] = [];
  let position = 0;
  for (const line of lines) {
    starts.push(position);
    position += line.length + 1;
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const start = starts[index]!;
        const cursorHere =
          isActive && buffer.cursor >= start && buffer.cursor <= start + line.length;
        const column = buffer.cursor - start;
        return (
          <Box key={index}>
            <Text color="cyan">{index === 0 ? `${glyphs.prompt} ` : '  '}</Text>
            {cursorHere ? (
              <Text>
                {line.slice(0, column)}
                <Text inverse>{line[column] ?? ' '}</Text>
                {line.slice(column + 1)}
              </Text>
            ) : (
              <Text>{line}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
