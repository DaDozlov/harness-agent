import { Box, Text } from 'ink';
import { useMemo } from 'react';
import { failureSummary, formatDuration } from '../../format.js';
import { renderMarkdown } from '../markdown.js';
import { glyphs } from '../theme.js';
import type { TranscriptItem } from '../transcript.js';
import { Spinner } from './Spinner.js';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

const STATUS_COLORS: Record<ToolItem['status'], string> = {
  ok: 'green',
  error: 'red',
  denied: 'yellow',
  cancelled: 'gray',
  running: 'cyan',
  approval: 'yellow',
};

export interface ItemViewProps {
  item: TranscriptItem;
  previous?: TranscriptItem | undefined;
  /**
   * For items in the live area: the screen space they may use. Ink cannot redraw a live area
   * taller than the terminal, so streaming text beyond it shows only its last lines.
   */
  space?: { rows: number; columns: number } | undefined;
}

export function ItemView({ item, previous, space }: ItemViewProps) {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="gray">{glyphs.prompt} </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      return <AssistantText text={item.text} space={item.done ? undefined : space} />;
    case 'tool':
      return <ToolLine item={item} spaced={previous?.kind !== 'tool'} />;
    case 'notice':
      return (
        <Box marginTop={1}>
          <Text
            color={item.tone === 'error' ? 'red' : item.tone === 'warning' ? 'yellow' : undefined}
            dimColor={item.tone === 'info'}
          >
            {item.text}
          </Text>
        </Box>
      );
  }
}

function AssistantText({ text, space }: { text: string; space: ItemViewProps['space'] }) {
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  const shown = space ? lastLinesThatFit(rendered, space.rows, space.columns) : rendered;
  return (
    <Box marginTop={1}>
      <Text>{shown}</Text>
    </Box>
  );
}

/**
 * The end of `text` that fits in `rows` screen lines of width `columns`, counting wrapped lines.
 * The full text is printed once it is finished.
 */
export function lastLinesThatFit(text: string, rows: number, columns: number): string {
  const lines = text.split('\n');
  const width = Math.max(1, columns);
  let used = 0;
  let start = lines.length;
  while (start > 0) {
    // eslint-disable-next-line no-control-regex -- measuring text without its color codes
    const visible = lines[start - 1]!.replace(/\u001b\[[0-9;]*m/g, '').length;
    const height = Math.max(1, Math.ceil(visible / width));
    if (used + height > rows - 1) break;
    used += height;
    start--;
  }
  return start === 0 ? text : ['…', ...lines.slice(start)].join('\n');
}

function ToolLine({ item, spaced }: { item: ToolItem; spaced: boolean }) {
  const space = item.label.indexOf(' ');
  const name = space === -1 ? item.label : item.label.slice(0, space);
  const detail = space === -1 ? '' : item.label.slice(space);
  const below = detailLines(item);

  // A sub-agent's calls sit under the delegate call that started it, with its name.
  return (
    <Box
      flexDirection="column"
      marginTop={spaced && !item.agent ? 1 : 0}
      paddingLeft={item.agent ? 2 : 0}
    >
      <Box>
        {item.status === 'running' ? (
          <Spinner />
        ) : (
          <Text color={STATUS_COLORS[item.status]}>{glyphs.bullet}</Text>
        )}
        <Text> </Text>
        {item.agent ? <Text color="magenta">{item.agent} </Text> : null}
        <Text bold>{name}</Text>
        <Text>{detail}</Text>
        {item.status === 'ok' && item.durationMs !== undefined && item.durationMs >= 1_000 ? (
          <Text dimColor> ({formatDuration(item.durationMs)})</Text>
        ) : null}
      </Box>
      {below.map((line, index) => (
        <Box key={index} paddingLeft={2}>
          <Text color={line.color} dimColor={!line.color}>
            {index === 0 ? glyphs.branch : ' '} {line.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function detailLines(item: ToolItem): Array<{ text: string; color?: string }> {
  switch (item.status) {
    case 'approval':
      return [{ text: 'waiting for your approval', color: 'yellow' }];
    case 'denied':
      return [{ text: firstSentence(item.output ?? 'Denied.'), color: 'yellow' }];
    case 'error':
      return [{ text: failureSummary(item.output ?? ''), color: 'red' }];
    case 'cancelled':
      return [{ text: 'cancelled' }];
    case 'ok':
      if (item.todos) return checklist(item.todos);
      // The end of a command's output usually says how it went.
      return item.tool === 'run_command' ? commandTail(item.output ?? '') : [];
    default:
      return [];
  }
}

const TODO_MARKS = {
  pending: glyphs.todo,
  in_progress: glyphs.todoActive,
  completed: glyphs.todoDone,
};

function checklist(todos: NonNullable<ToolItem['todos']>): Array<{ text: string; color?: string }> {
  return todos.map((todo) => ({
    text: `${TODO_MARKS[todo.status]} ${todo.content}`,
    ...(todo.status === 'in_progress' && { color: 'cyan' }),
  }));
}

function commandTail(output: string): Array<{ text: string }> {
  const lines = output
    .split('\n')
    .filter((line) => line.trim() && !/^\[exit code \d+\]$/.test(line.trim()));
  return lines
    .slice(-3)
    .map((line) => ({ text: line.length > 160 ? `${line.slice(0, 160)}…` : line }));
}

function firstSentence(text: string): string {
  const sentence = /^.*?[.!?](\s|$)/.exec(text)?.[0]?.trim() ?? text;
  return sentence.length > 200 ? `${sentence.slice(0, 200)}…` : sentence;
}
