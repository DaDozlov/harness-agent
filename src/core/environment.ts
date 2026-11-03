import { platform } from 'node:os';

export interface EnvironmentInfo {
  now: Date;
  timeZone: string;
  platform: NodeJS.Platform;
  cwd: string;
  /** Present when the agent has tools: where they act and which shell runs commands. */
  workspace?: { kind: string; shell: string; description?: string } | undefined;
  /** Branch and uncommitted changes, when the workspace is a git repository. */
  git?: string | undefined;
  /** The session id, which the agent can cite, e.g. in a pull request description. */
  session?: string | undefined;
}

export function currentEnvironment(): EnvironmentInfo {
  return {
    now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: platform(),
    cwd: process.cwd(),
  };
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/**
 * The environment block of the system prompt (docs/DESIGN.md §4.6). The model knows nothing
 * about the world it runs in unless the harness tells it, not even today's date. The time of
 * day is left out on purpose: it would change the prompt on every call and defeat prompt caching.
 */
export function formatEnvironment(info: EnvironmentInfo): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: info.timeZone, weekday: 'long' }).format(
    info.now,
  );
  // en-CA formats dates as YYYY-MM-DD.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: info.timeZone }).format(info.now);
  const lines = [
    '<environment>',
    `Today: ${day}, ${date} (time zone ${info.timeZone})`,
    `Operating system: ${OS_NAMES[info.platform] ?? info.platform}`,
    `Working directory: ${info.cwd}`,
  ];
  if (info.workspace) {
    lines.push(
      `Workspace: ${info.workspace.kind}`,
      `Shell for run_command: ${info.workspace.shell}`,
      ...(info.workspace.description ? [info.workspace.description] : []),
    );
  }
  if (info.git) lines.push(`Git (when the session started): ${info.git}`);
  if (info.session) lines.push(`heaw session: ${info.session}`);
  lines.push('</environment>');
  return lines.join('\n');
}
