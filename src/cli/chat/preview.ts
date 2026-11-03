export interface PreviewLine {
  text: string;
  color?: 'red' | 'green' | 'gray';
}

const MAX_LINES = 10;

type Text = (key: string) => string | undefined;

/** Previews by tool; undefined when the arguments are not what the preview needs. */
const PREVIEWS: Record<
  string,
  (text: Text, args: Record<string, unknown>) => PreviewLine[] | undefined
> = {
  mcp_reload: () => [
    { text: 'Starts the MCP servers configured in .mcp.json and ~/.heaw/mcp.json,' },
    { text: 'and stops servers that were removed.' },
    { text: 'MCP servers are programs that run on this computer.', color: 'gray' },
  ],
  web_fetch: (text) => (text('url') === undefined ? undefined : [{ text: `GET ${text('url')}` }]),
  http_request: (text, args) => {
    if (text('url') === undefined) return undefined;
    const body =
      args.json !== undefined ? JSON.stringify(args.json, null, 2) : (text('body') ?? '');
    return [
      { text: `${text('method') ?? 'GET'} ${text('url')}` },
      ...limited(body ? body.split('\n') : [], (line) => ({ text: line, color: 'gray' }), 8),
    ];
  },
  run_command: (text) => {
    const [command, cwd] = [text('command'), text('cwd')];
    if (command === undefined) return undefined;
    return [
      { text: `$ ${command}` },
      ...(cwd ? [{ text: `in ${cwd}`, color: 'gray' as const }] : []),
    ];
  },
  write_file: (text) => {
    const content = text('content');
    return content === undefined
      ? undefined
      : limited(content.split('\n'), (line) => ({ text: line }));
  },
  edit_file: (text) => {
    const [before, after] = [text('old_string'), text('new_string')];
    if (before === undefined || after === undefined) return undefined;
    return [
      ...limited(before.split('\n'), (line) => ({ text: `- ${line}`, color: 'red' }), 5),
      ...limited(after.split('\n'), (line) => ({ text: `+ ${line}`, color: 'green' }), 5),
    ];
  },
};

/** What a tool call would do, for the approval prompt: the command, the content, the change. */
export function approvalPreview(tool: string, args: unknown): PreviewLine[] {
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const text: Text = (key) => (typeof record[key] === 'string' ? record[key] : undefined);
  const preview = Object.hasOwn(PREVIEWS, tool) ? PREVIEWS[tool]!(text, record) : undefined;
  if (preview) return preview;
  const json = JSON.stringify(args, null, 2) ?? '';
  return json === '{}' ? [] : limited(json.split('\n'), (line) => ({ text: line, color: 'gray' }));
}

function limited(
  lines: string[],
  map: (line: string) => PreviewLine,
  max = MAX_LINES,
): PreviewLine[] {
  const shown = lines
    .slice(0, max)
    .map((line) => map(line.length > 200 ? `${line.slice(0, 200)}…` : line));
  const more = lines.length - max;
  return more > 0
    ? [...shown, { text: `… ${more} more line${more === 1 ? '' : 's'}`, color: 'gray' }]
    : shown;
}
