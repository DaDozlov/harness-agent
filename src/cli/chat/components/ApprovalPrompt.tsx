import { Box, Text } from 'ink';
import { useState } from 'react';
import type { ApprovalDecision, EngineEvent } from '../../../core/events.js';
import { toolLabel } from '../../format.js';
import { approvalPreview } from '../preview.js';
import { useKeys } from '../keyboard.js';
import { glyphs } from '../theme.js';
import { useEditableBuffer } from '../use-buffer.js';
import { PromptInput } from './PromptInput.js';

export type ApprovalRequestEvent = Extract<EngineEvent, { type: 'approval.request' }>;

/** "a": what it allows depends on the call (`forSession`), e.g. all file edits. */
const SESSION_LABEL = 'Yes, and allow this exact call for the rest of the session';

const OPTIONS = [
  { key: 'y', label: 'Yes', decision: { allow: true, scope: 'once' } },
  { key: 'a', label: SESSION_LABEL, decision: { allow: true, scope: 'session' } },
  { key: 'n', label: 'No', decision: { allow: false } },
  { key: 'f', label: 'No, and tell heaw what to do instead', decision: undefined },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  decision: ApprovalDecision | undefined;
}>;

/**
 * Asks the user about one tool call. Keys: ↑/↓ and Enter, or y / a / n / f. Esc answers no.
 * "f" opens a line for feedback that goes to the model with the denial.
 */
export function ApprovalPrompt({
  request,
  agent,
  onAnswer,
  maxPreviewLines,
  waiting = 0,
}: {
  request: ApprovalRequestEvent;
  /** The sub-agent asking, when it is not the user's agent. */
  agent?: string | undefined;
  onAnswer: (decision: ApprovalDecision) => void;
  /** Lines the preview may use, so the prompt fits the screen. */
  maxPreviewLines?: number | undefined;
  /** Requests waiting after this one (parallel sub-agents). */
  waiting?: number;
}) {
  const [selected, setSelected] = useState(0);
  const [writingFeedback, setWritingFeedback] = useState(false);
  const feedback = useEditableBuffer();

  const choose = (index: number) => {
    const option = OPTIONS[index];
    if (!option) return;
    if (option.decision) onAnswer(option.decision);
    else setWritingFeedback(true);
  };

  useKeys(
    (input, key) => {
      if (key.escape) return onAnswer({ allow: false });
      if (key.upArrow) return setSelected((index) => (index + OPTIONS.length - 1) % OPTIONS.length);
      if (key.downArrow) return setSelected((index) => (index + 1) % OPTIONS.length);
      if (key.return) return choose(selected);
      const byKey = OPTIONS.findIndex((option) => option.key === input.toLowerCase());
      const byNumber = Number(input) - 1;
      if (byKey !== -1) return choose(byKey);
      if (byNumber >= 0 && byNumber < OPTIONS.length) choose(byNumber);
    },
    { isActive: !writingFeedback },
  );
  useKeys(
    (_input, key) => {
      if (key.escape) setWritingFeedback(false);
    },
    { isActive: writingFeedback },
  );

  const full = approvalPreview(request.tool, request.args);
  const max = Math.max(1, maxPreviewLines ?? full.length);
  const preview =
    full.length > max
      ? [
          ...full.slice(0, max - 1),
          { text: `… ${full.length - max + 1} more lines`, color: 'gray' as const },
        ]
      : full;
  return (
    <Box
      flexDirection="column"
      borderStyle={glyphs.border}
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
    >
      <Text bold>
        {agent ? `The sub-agent ${agent} asks: allow ` : 'Allow '}
        {toolLabel(request.tool, request.args)}?
      </Text>
      <Text dimColor>Asking because {request.reason}.</Text>
      {waiting > 0 ? (
        <Text color="yellow">
          {waiting} more {waiting === 1 ? 'request is' : 'requests are'} waiting after this one.
        </Text>
      ) : null}
      {preview.length ? (
        <Box flexDirection="column" marginY={1} paddingLeft={1}>
          {preview.map((line, index) => (
            <Text key={index} color={line.color}>
              {line.text}
            </Text>
          ))}
        </Box>
      ) : null}
      {writingFeedback ? (
        <Box flexDirection="column">
          <Text>What should heaw do instead? (Enter to send, Esc to go back)</Text>
          <PromptInput
            buffer={feedback.buffer}
            edit={feedback.edit}
            isActive
            onEnter={() =>
              onAnswer({ allow: false, feedback: feedback.current().text.trim() || undefined })
            }
          />
        </Box>
      ) : (
        OPTIONS.map((option, index) => (
          <Text key={option.key} color={index === selected ? 'cyan' : undefined}>
            {index === selected ? glyphs.pointer : ' '} {index + 1}.{' '}
            {option.key === 'a' && request.forSession
              ? `Yes, and ${request.forSession}`
              : option.label}{' '}
            <Text dimColor>({option.key})</Text>
          </Text>
        ))
      )}
    </Box>
  );
}
