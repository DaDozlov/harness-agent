import { Box, Text } from 'ink';
import type { PermissionMode } from '../../../core/permissions.js';
import type { Usage } from '../../../core/usage.js';
import { formatCost, formatTokens } from '../../format.js';
import { MODE_COLORS } from '../theme.js';

export interface StatusBarProps {
  model: string;
  mode: PermissionMode;
  usage: Usage;
  /** Hidden while unknown. */
  costUsd?: number | undefined;
  /** Size of the next request against what the model allows. */
  context?: { tokens: number; limit: number } | undefined;
  sessionId: string;
  running: boolean;
  exitArmed: boolean;
  /** Connected and configured MCP servers; hidden when there are none. */
  mcp?: { connected: number; total: number; failed: number } | undefined;
}

export function StatusBar({
  model,
  mode,
  usage,
  costUsd,
  context,
  sessionId,
  running,
  exitArmed,
  mcp,
}: StatusBarProps) {
  const tokens = usage.inputTokens + usage.outputTokens;
  const filled = context ? Math.min(100, Math.round((context.tokens / context.limit) * 100)) : 0;
  const hint = exitArmed
    ? 'press Ctrl+C again to exit'
    : running
      ? 'esc to interrupt'
      : 'shift+tab: mode · /help';
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor>
        {model} · <Text color={MODE_COLORS[mode]}>{mode}</Text>
        <Text dimColor>
          {' '}
          · {formatTokens(tokens)} tokens{costUsd === undefined ? '' : ` · ${formatCost(costUsd)}`}
        </Text>
        {context ? (
          <Text color={filled >= 70 ? 'yellow' : undefined} dimColor={filled < 70}>
            {' '}
            · ctx {filled}%
          </Text>
        ) : null}
        <Text dimColor> · {sessionId}</Text>
        {mcp?.total ? (
          <Text color={mcp.failed ? 'yellow' : undefined} dimColor={!mcp.failed}>
            {' '}
            · mcp {mcp.connected}/{mcp.total}
          </Text>
        ) : null}
      </Text>
      <Text color={exitArmed ? 'yellow' : undefined} dimColor={!exitArmed}>
        {hint}
      </Text>
    </Box>
  );
}
