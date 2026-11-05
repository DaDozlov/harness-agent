import picomatch from 'picomatch';

/** What a tool does to the world. Permission modes decide per kind (docs/DESIGN.md §4.10). */
export type ToolKind = 'read' | 'write' | 'execute' | 'network';

export type PermissionMode = 'default' | 'accept-edits' | 'read-only' | 'bypass';

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'accept-edits',
  'read-only',
  'bypass',
];

export interface PermissionRules {
  mode?: PermissionMode | undefined;
  allow?: string[] | undefined;
  ask?: string[] | undefined;
  deny?: string[] | undefined;
  /**
   * Approved in advance for this session or run, e.g. `--allow` or `runAgent`'s `allow`. Like
   * approvals the user gives when asked, they also cover calls that ask rules would ask about.
   * Deny rules still win.
   */
  preapproved?: string[] | undefined;
}

export type Decision = 'allow' | 'ask' | 'deny';

export interface PermissionCheck {
  decision: Decision;
  /** Why, in words the user and the model can act on. */
  reason: string;
}

export interface Subject {
  value: string;
  type: 'path' | 'text';
}

export interface PermissionSummary {
  mode: PermissionMode;
  allow: string[];
  ask: string[];
  deny: string[];
  preapproved: string[];
  /** Calls the user allowed "for this session". */
  sessionApprovals: number;
  /** Commands the user allowed by prefix "for this session", as rules. */
  sessionRules: string[];
}

/** A permission rule could not be parsed. */
export class PermissionRuleError extends Error {
  override readonly name = 'PermissionRuleError';
}

const MODE_DEFAULTS: Record<PermissionMode, Record<ToolKind, Decision>> = {
  default: { read: 'allow', write: 'ask', execute: 'ask', network: 'ask' },
  'accept-edits': { read: 'allow', write: 'allow', execute: 'ask', network: 'ask' },
  'read-only': { read: 'allow', write: 'deny', execute: 'deny', network: 'ask' },
  bypass: { read: 'allow', write: 'allow', execute: 'allow', network: 'allow' },
};

/**
 * Files that control the harness itself: config (code that runs when heaw starts), MCP servers
 * (commands it starts), agents, skills, memory, session logs, and git's hooks and config (code
 * that git runs). Changing them is always asked about, in every mode and whatever the allow
 * rules say, so an agent cannot loosen its own guardrails or plant code that runs later outside
 * its sandbox. An approval (asked, or given in advance with `--allow`) still lets it through.
 */
export const PROTECTED_PATHS: readonly string[] = [
  'heaw.config.*',
  '.mcp.json',
  '.heaw/**',
  '.git/**',
];

interface Rule {
  source: string;
  matchesTool: (name: string) => boolean;
  /** Absent: the rule matches every call of the tool. */
  pattern?: string;
}

/**
 * Decides allow / ask / deny for each tool call (docs/DESIGN.md §4.10).
 * Order: deny rules, approvals (given for this session, or in advance), protected paths, ask
 * rules, commands allowed by prefix for this session, allow rules, mode default.
 *
 * Rules are `tool` or `tool(pattern)`. `*` in the tool name matches any characters. The pattern
 * is a glob for path subjects (`src/**`, `**\/.env*`) and a wildcard text match for everything
 * else (`npm test*`), where `*` matches any characters including spaces and slashes.
 */
export class PermissionPolicy {
  #mode: PermissionMode = 'default';
  readonly #deny: Rule[];
  readonly #ask: Rule[];
  readonly #allow: Rule[];
  readonly #preapproved: Rule[];
  readonly #sessionApprovals = new Set<string>();
  /** Command prefixes allowed for the session, by tool. */
  readonly #sessionCommands: Array<{ tool: string; prefix: string }> = [];

  constructor(rules: PermissionRules = {}) {
    this.setMode(rules.mode ?? 'default');
    this.#deny = (rules.deny ?? []).map(parseRule);
    this.#ask = (rules.ask ?? []).map(parseRule);
    this.#allow = (rules.allow ?? []).map(parseRule);
    this.#preapproved = (rules.preapproved ?? []).map(parseRule);
  }

  check(
    tool: { name: string; kind: ToolKind; alwaysAsk?: boolean | undefined },
    subject: Subject | undefined,
  ): PermissionCheck {
    const deny = this.#deny.find((rule) => matches(rule, tool.name, subject));
    if (deny) return { decision: 'deny', reason: `it matches the deny rule "${deny.source}"` };

    if (this.#sessionApprovals.has(approvalKey(tool.name, subject))) {
      return { decision: 'allow', reason: 'the user allowed it for this session' };
    }
    const preapproved = this.#preapproved.find((rule) => matches(rule, tool.name, subject));
    if (preapproved) {
      return { decision: 'allow', reason: `it was allowed in advance by "${preapproved.source}"` };
    }

    const guarded = protectedPath(tool, subject);
    if (guarded) {
      // Never looser than the mode: read-only still denies.
      const decision = MODE_DEFAULTS[this.#mode][tool.kind] === 'deny' ? 'deny' : 'ask';
      return {
        decision,
        reason: `it changes ${guarded}, which controls heaw itself, so it is always asked about`,
      };
    }

    if (tool.alwaysAsk) return { decision: 'ask', reason: 'it always needs your approval' };

    const ask = this.#ask.find((rule) => matches(rule, tool.name, subject));
    if (ask) return { decision: 'ask', reason: `it matches the ask rule "${ask.source}"` };

    const granted = this.#sessionCommands.find(
      (grant) => grant.tool === tool.name && coversCommand(grant.prefix, subject),
    );
    if (granted) {
      return {
        decision: 'allow',
        reason: `the user allowed commands starting with "${granted.prefix}" for this session`,
      };
    }

    const allow = this.#allow.find((rule) => matches(rule, tool.name, subject));
    if (allow) return { decision: 'allow', reason: `it matches the allow rule "${allow.source}"` };

    const decision = MODE_DEFAULTS[this.#mode][tool.kind];
    return {
      decision,
      reason: `${tool.kind} actions are set to "${decision}" in ${this.#mode} mode`,
    };
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  /** Changes the mode for the next calls; rules and session approvals stay. */
  setMode(mode: PermissionMode): void {
    if (!PERMISSION_MODES.includes(mode)) {
      throw new PermissionRuleError(
        `Unknown permission mode "${String(mode)}". Use one of: ${PERMISSION_MODES.join(', ')}.`,
      );
    }
    this.#mode = mode;
  }

  /** The current mode and rules, e.g. to show the user. */
  describe(): PermissionSummary {
    const sources = (rules: Rule[]) => rules.map((rule) => rule.source);
    return {
      mode: this.#mode,
      allow: sources(this.#allow),
      ask: sources(this.#ask),
      deny: sources(this.#deny),
      preapproved: sources(this.#preapproved),
      sessionApprovals: this.#sessionApprovals.size,
      sessionRules: this.#sessionCommands.map(({ tool, prefix }) => `${tool}(${prefix}*)`),
    };
  }

  /** Allows this exact call (tool and subject) for the rest of the session. */
  allowForSession(toolName: string, subject: Subject | undefined): void {
    this.#sessionApprovals.add(approvalKey(toolName, subject));
  }

  /**
   * What "yes for the session" allows for a call the user is asked about, in words for the
   * prompt: allowing only the exact call would ask again for every new file and every variant of
   * a command (a test run with another filter).
   */
  describeSessionGrant(tool: { name: string; kind: ToolKind }, subject: Subject | undefined) {
    const grant = this.#sessionGrant(tool, subject);
    if (grant === 'edits') return 'allow all file edits for this session (accept-edits mode)';
    if (grant) return `allow commands starting with "${grant.prefix}" for this session`;
    return 'allow this exact call for the rest of the session';
  }

  /**
   * "Yes for the session": allows the call itself, and more where that is safe to say (see
   * `describeSessionGrant`): file edits switch `default` mode to `accept-edits` (protected files
   * are still asked about), commands are allowed by their leading words. Ask rules still ask.
   */
  approveForSession(tool: { name: string; kind: ToolKind }, subject: Subject | undefined): void {
    const grant = this.#sessionGrant(tool, subject);
    this.allowForSession(tool.name, subject);
    if (grant === 'edits') this.setMode('accept-edits');
    else if (grant) this.#sessionCommands.push({ tool: tool.name, prefix: grant.prefix });
  }

  #sessionGrant(
    tool: { name: string; kind: ToolKind },
    subject: Subject | undefined,
  ): 'edits' | { prefix: string } | undefined {
    if (tool.kind === 'write') {
      return this.#mode === 'default' && !protectedPath(tool, subject) ? 'edits' : undefined;
    }
    if (tool.kind !== 'execute' || subject?.type !== 'text') return undefined;
    const prefix = commandPrefix(subject.value);
    return prefix === undefined ? undefined : { prefix };
  }

  /** The allow rules that apply to a tool, so a denied model can see what it may do instead. */
  allowRulesFor(toolName: string): string[] {
    return [...this.#preapproved, ...this.#allow]
      .filter((rule) => rule.matchesTool(toolName))
      .map((rule) => rule.source);
  }

  /**
   * A stricter view of this policy, e.g. for a sub-agent: every call needs this policy's
   * permission and also passes `mode` and `deny`. It can only deny or ask more, never less, and
   * it follows this policy as it changes (mode switches, session approvals).
   */
  restricted(restriction: { mode?: PermissionMode; deny?: string[] }): PermissionPolicy {
    return new RestrictedPolicy(this, restriction);
  }
}

const STRICTNESS: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

class RestrictedPolicy extends PermissionPolicy {
  readonly #base: PermissionPolicy;
  readonly #mode: PermissionMode | undefined;

  constructor(base: PermissionPolicy, restriction: { mode?: PermissionMode; deny?: string[] }) {
    // Without a mode, the restriction adds only its deny rules: bypass leaves the rest to `base`.
    super({ mode: restriction.mode ?? 'bypass', deny: restriction.deny ?? [] });
    this.#base = base;
    this.#mode = restriction.mode;
  }

  override get mode(): PermissionMode {
    return this.#mode ?? this.#base.mode;
  }

  override check(
    tool: { name: string; kind: ToolKind; alwaysAsk?: boolean | undefined },
    subject: Subject | undefined,
  ) {
    const base = this.#base.check(tool, subject);
    const own = super.check(tool, subject);
    return STRICTNESS[own.decision] > STRICTNESS[base.decision] ? own : base;
  }

  override allowForSession(toolName: string, subject: Subject | undefined): void {
    this.#base.allowForSession(toolName, subject);
  }

  override describeSessionGrant(
    tool: { name: string; kind: ToolKind },
    subject: Subject | undefined,
  ): string {
    return this.#base.describeSessionGrant(tool, subject);
  }

  override approveForSession(
    tool: { name: string; kind: ToolKind },
    subject: Subject | undefined,
  ): void {
    this.#base.approveForSession(tool, subject);
  }

  override allowRulesFor(toolName: string): string[] {
    return this.#base.allowRulesFor(toolName);
  }
}

/** The protected path a write would change, if any. */
function protectedPath(tool: { kind: ToolKind }, subject: Subject | undefined) {
  if (tool.kind !== 'write' || subject?.type !== 'path') return undefined;
  const nocase = process.platform === 'win32';
  const hit = PROTECTED_PATHS.some((pattern) =>
    picomatch.isMatch(subject.value, pattern, { dot: true, nocase }),
  );
  return hit ? subject.value : undefined;
}

/** A rule that would allow exactly this call, to suggest to the user. */
export function suggestRule(toolName: string, subject: Subject | undefined): string {
  return subject ? `${toolName}(${subject.value})` : toolName;
}

/** Chaining, redirection and substitution: a command with any of these is only allowed exactly. */
const SHELL_SYNTAX = /[;&|<>`\r\n]|\$\(/;

/** Programs that run arbitrary code or destroy things: never allowed by prefix. */
const EXACT_ONLY = new Set([
  ...['bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'env', 'sudo', 'su', 'xargs'],
  ...['eval', 'exec', 'nohup', 'timeout', 'time', 'watch', 'start', 'ssh', 'scp', 'curl', 'wget'],
  ...['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'java'],
  ...['docker', 'podman', 'kubectl', 'rm', 'rmdir', 'del', 'erase', 'rd', 'mv', 'move', 'dd'],
  ...['chmod', 'chown', 'kill', 'pkill', 'killall', 'taskkill', 'shutdown', 'reboot', 'format'],
]);

/**
 * The leading words of a command that "yes for the session" allows: the program and up to two
 * more words that are subcommands or simple flags (`./mvnw -q test`, `npm run build`, `git
 * status`). None for commands with shell syntax or programs that can run anything.
 */
export function commandPrefix(command: string): string | undefined {
  const text = command.trim();
  if (!text || SHELL_SYNTAX.test(text)) return undefined;
  const [program = '', ...rest] = text.split(/\s+/);
  const name = program
    .replace(/^.*[/\\]/, '')
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  if (EXACT_ONLY.has(name)) return undefined;
  const words = [program];
  for (const word of rest.slice(0, 2)) {
    if (!/^(-{1,2})?[a-z][\w:.-]*$/i.test(word)) break;
    words.push(word);
  }
  return words.join(' ');
}

/** A prefix covers the command itself and the command with more arguments, nothing chained. */
function coversCommand(prefix: string, subject: Subject | undefined): boolean {
  if (subject?.type !== 'text' || SHELL_SYNTAX.test(subject.value)) return false;
  const command = subject.value.trim();
  return command === prefix || command.startsWith(`${prefix} `);
}

function approvalKey(toolName: string, subject: Subject | undefined): string {
  return `${toolName}\u0000${subject?.value ?? ''}`;
}

function parseRule(source: string): Rule {
  const match = /^([\w.*-]+)(?:\((.*)\))?$/s.exec(source.trim());
  const name = match?.[1];
  const pattern = match?.[2];
  if (!name || pattern === '') {
    throw new PermissionRuleError(
      `Invalid permission rule "${source}". Use tool or tool(pattern), ` +
        'e.g. run_command(npm test*) or mcp__github__get_*.',
    );
  }
  const toolPattern = wildcard(name);
  return {
    source,
    matchesTool: (toolName) => toolPattern.test(toolName),
    ...(pattern !== undefined && { pattern }),
  };
}

function matches(rule: Rule, toolName: string, subject: Subject | undefined): boolean {
  if (!rule.matchesTool(toolName)) return false;
  if (rule.pattern === undefined) return true;
  if (!subject) return false;
  if (subject.type === 'path') {
    return picomatch.isMatch(subject.value, rule.pattern, {
      dot: true,
      nocase: process.platform === 'win32',
    });
  }
  return wildcard(rule.pattern).test(subject.value);
}

/** `*` matches any characters; everything else is literal. */
function wildcard(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's');
}
