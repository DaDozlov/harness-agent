import { Box, Text } from 'ink';
import { useState } from 'react';
import type { SessionSummary } from '../../../core/session-store.js';
import { useKeys } from '../keyboard.js';
import { glyphs } from '../theme.js';

/** Lists saved sessions to resume. ↑/↓ and Enter pick one; Esc starts a new conversation. */
export function SessionPicker({
  sessions,
  onPick,
  onCancel,
}: {
  sessions: SessionSummary[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(0);
  useKeys((_input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) return setSelected((index) => Math.max(0, index - 1));
    if (key.downArrow) return setSelected((index) => Math.min(sessions.length - 1, index + 1));
    if (key.return && sessions[selected]) onPick(sessions[selected].id);
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>Resume a conversation</Text>
      <Text dimColor>↑/↓ to choose · Enter to resume · Esc for a new conversation</Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.map((session, index) => (
          <Text key={session.id} color={index === selected ? 'cyan' : undefined}>
            {index === selected ? glyphs.pointer : ' '} {formatWhen(session.updatedAt)}
            {'  '}
            <Text dimColor>{String(session.messages).padStart(3)} msgs</Text>
            {'  '}
            {session.title || <Text dimColor>(no messages)</Text>}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? `today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`.padEnd(13)
    : date
        .toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        .padEnd(13);
}
