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
  /** Decided by the mode's default for the tool's kind, not by a rule, grant or approval. */
  byMode?: boolean;
}

/** What a restricted view (e.g. for a sub-agent) adds to the policy it is made from. */
export interface PermissionRestriction {
  /** A stricter mode: what it denies is denied, and what it asks about is asked about unless a
   * rule, a grant or an approval allows it. */
  mode?: PermissionMode | undefined;
  deny?: string[] | undefined;
  /** Globs of the only files write tools may change. */
  writable?: string[] | undefined;
  /**
   * Tools the agent brought itself (the MCP servers in its agent file): allowed in any mode, since
   * the user gave them to this agent, unless a deny rule matches.
   */
  own?: ((toolName: string) => boolean) | undefined;
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
 *
 * A command line runs each of its commands (`a && b`, `a; b`, `a | b`): deny and ask rules match
 * if any command matches, and allow rules and session grants allow it only when each command is
 * allowed. Output piped into a filter such as `tail` needs nothing. A pattern never allows a
 * command with substitution (`$(…)`, backticks).
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
    const commands = commandsOf(tool, subject);
    const deny = this.#deny.find((rule) => matchesAny(rule, tool.name, subject, commands));
    if (deny) return { decision: 'deny', reason: `it matches the deny rule "${deny.source}"` };

    if (this.#sessionApprovals.has(approvalKey(tool.name, subject))) {
      return { decision: 'allow', reason: 'the user allowed it for this session' };
    }
    const preapproved = allowedEach(subject, commands, (one) =>
      ruleFor(this.#preapproved, tool.name, one),
    );
    if (preapproved) {
      const sources = unique(preapproved.map((allowance) => `"${allowance.text}"`));
      return { decision: 'allow', reason: `it was allowed in advance by ${sources.join(' and ')}` };
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

    const ask = this.#ask.find((rule) => matchesAny(rule, tool.name, subject, commands));
    if (ask) return { decision: 'ask', reason: `it matches the ask rule "${ask.source}"` };

    const allowed = allowedEach(subject, commands, (one) => {
      const grant = this.#sessionCommands.find(
        ({ tool: name, prefix }) =>
          name === tool.name && one?.type === 'text' && coversCommand(prefix, one.value),
      );
      return grant ? { by: 'grant', text: grant.prefix } : ruleFor(this.#allow, tool.name, one);
    });
    if (allowed) return { decision: 'allow', reason: allowReason(allowed) };

    const decision = MODE_DEFAULTS[this.#mode][tool.kind];
    return {
      decision,
      reason: `${tool.kind} actions are set to "${decision}" in ${this.#mode} mode`,
      byMode: true,
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
    if (grant) {
      const prefixes = grant.prefixes.map((prefix) => `"${prefix}"`).join(' or ');
      return `allow commands starting with ${prefixes} for this session`;
    }
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
    for (const prefix of grant && grant !== 'edits' ? grant.prefixes : []) {
      const known = this.#sessionCommands.some(
        (command) => command.tool === tool.name && command.prefix === prefix,
      );
      if (!known) this.#sessionCommands.push({ tool: tool.name, prefix });
    }
  }

  /** Commands are granted by the leading words of each command of the line, if all have some. */
  #sessionGrant(
    tool: { name: string; kind: ToolKind },
    subject: Subject | undefined,
  ): 'edits' | { prefixes: string[] } | undefined {
    if (tool.kind === 'write') {
      return this.#mode === 'default' && !protectedPath(tool, subject) ? 'edits' : undefined;
    }
    const commands = commandsOf(tool, subject);
    if (!commands) return undefined;
    const prefixes: string[] = [];
    for (const command of commands) {
      if (isFilter(command)) continue;
      const prefix = commandPrefix(command.text);
      if (prefix === undefined) return undefined;
      prefixes.push(prefix);
    }
    return prefixes.length ? { prefixes: unique(prefixes) } : undefined;
  }

  /** The allow rules that apply to a tool, so a denied model can see what it may do instead. */
  allowRulesFor(toolName: string): string[] {
    return [...this.#preapproved, ...this.#allow]
      .filter((rule) => rule.matchesTool(toolName))
      .map((rule) => rule.source);
  }

  /**
   * A stricter view of this policy, e.g. for a sub-agent: every call needs this policy's
   * permission and also passes the restriction. It can only deny or ask more, never less, and
   * it follows this policy as it changes (mode switches, session approvals).
   */
  restricted(restriction: PermissionRestriction): PermissionPolicy {
    return new RestrictedPolicy(this, restriction);
  }
}

const STRICTNESS: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

const stricter = (a: PermissionCheck, b: PermissionCheck) =>
  STRICTNESS[b.decision] > STRICTNESS[a.decision] ? b : a;

class RestrictedPolicy extends PermissionPolicy {
  readonly #base: PermissionPolicy;
  readonly #mode: PermissionMode | undefined;
  readonly #writable: string[] | undefined;
  readonly #own: ((toolName: string) => boolean) | undefined;

  constructor(base: PermissionPolicy, restriction: PermissionRestriction) {
    // Its own rules are only the deny rules: bypass leaves everything else to `base` and the mode.
    super({ mode: 'bypass', deny: restriction.deny ?? [] });
    this.#base = base;
    this.#mode = restriction.mode;
    this.#writable = restriction.writable;
    this.#own = restriction.own;
  }

  override get mode(): PermissionMode {
    return this.#mode ?? this.#base.mode;
  }

  /**
   * The base's decision, made stricter: deny rules, files outside `writable`, and the mode. What
   * the mode denies (writes in read-only) is denied; what it asks about (commands in
   * accept-edits) is asked about only where the base allows by its own mode, never past a rule,
   * a session grant or an approval the user gave.
   */
  override check(
    tool: { name: string; kind: ToolKind; alwaysAsk?: boolean | undefined },
    subject: Subject | undefined,
  ): PermissionCheck {
    let result = stricter(this.#base.check(tool, subject), super.check(tool, subject));
    if (this.#own?.(tool.name)) {
      return result.decision === 'deny' && !result.byMode
        ? result
        : { decision: 'allow', reason: "it is a tool of the agent's own MCP server" };
    }
    if (this.#writable && tool.kind === 'write' && subject?.type === 'path') {
      const nocase = process.platform === 'win32';
      const inside = this.#writable.some((pattern) =>
        picomatch.isMatch(subject.value, pattern, { dot: true, nocase }),
      );
      if (!inside) {
        result = stricter(result, {
          decision: 'deny',
          reason: `${subject.value} is outside the files this agent was given (${this.#writable.join(', ')})`,
        });
      }
    }
    const byMode = this.#mode && MODE_DEFAULTS[this.#mode][tool.kind];
    if (byMode === 'deny' || (byMode === 'ask' && result.decision === 'allow' && result.byMode)) {
      result = stricter(result, {
        decision: byMode,
        reason: `${tool.kind} actions are set to "${byMode}" in ${this.#mode} mode`,
        byMode: true,
      });
    }
    return result;
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

/** Runs code inside a command line, even within double quotes: `$(…)`, backticks, `<(…)`. */
const SUBSTITUTION = /`|\$\(|[<>]\(/;

/** Quoted text, which the shell takes literally once substitution is ruled out. */
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;

/** Redirections that only move output around: `2>&1`, `>/dev/null`. */
const HARMLESS_REDIRECT = /\s+\d?>(?:&\d|\s*\/dev\/null)(?=\s|$)/g;

/** Programs that only filter the output piped into them (`… | tail -50`). */
const PIPE_FILTERS = new Set(['head', 'tail', 'grep', 'wc', 'cut', 'tr']);

/** A command of a command line, and whether the output of the one before is piped into it. */
interface Command {
  text: string;
  piped: boolean;
}

/**
 * The commands a call runs, for a command line (an `execute` tool with a text subject): `null`
 * when the line cannot be split safely, undefined for any other call.
 */
function commandsOf(
  tool: { kind: ToolKind },
  subject: Subject | undefined,
): Command[] | null | undefined {
  if (tool.kind !== 'execute' || subject?.type !== 'text') return undefined;
  return splitCommands(subject.value);
}

/**
 * Splits a command line at `&&`, `||`, `;`, `|`, `&` and line breaks outside quotes. `null` for
 * a line with substitution or an open quote, which cannot be split safely.
 */
export function splitCommands(line: string): Command[] | null {
  if (SUBSTITUTION.test(line)) return null;
  const commands: Command[] = [];
  let current = '';
  let piped = false;
  let quote: string | undefined;
  const end = (pipesNext: boolean) => {
    const text = current.trim();
    if (text) commands.push({ text, piped });
    current = '';
    piped = pipesNext;
  };
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index);
    if (char === '\\' && quote !== "'") {
      current += line.slice(index, index + 2);
      index++;
    } else if (quote) {
      if (char === quote) quote = undefined;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (line.startsWith('&&', index) || line.startsWith('||', index)) {
      end(false);
      index++;
    } else if (char === '|') {
      end(true);
    } else if (char === ';' || char === '\n' || char === '\r') {
      end(false);
    } else if (char === '&' && !/[<>]$/.test(current)) {
      end(false);
    } else {
      current += char;
    }
  }
  if (quote) return null;
  end(false);
  return commands.length ? commands : null;
}

/** A single command: no chaining, redirection or substitution outside quotes. */
function isSimple(command: string): boolean {
  return !SUBSTITUTION.test(command) && !SHELL_SYNTAX.test(command.replace(QUOTED, "''"));
}

/** Output piped into a filter such as `tail -50` adds nothing that needs allowing. */
function isFilter(command: Command): boolean {
  const text = command.text.replace(HARMLESS_REDIRECT, '');
  return command.piped && isSimple(text) && PIPE_FILTERS.has(text.split(/\s+/)[0] ?? '');
}

/** What allows one command: a session grant (its prefix) or a rule (its source). */
interface Allowance {
  by: 'grant' | 'rule';
  text: string;
}

/**
 * Whether `allowOne` allows the call; a command line only when it allows each of its commands.
 * A line that cannot be split is allowed only by a rule without a pattern (`run_command`).
 */
function allowedEach(
  subject: Subject | undefined,
  commands: Command[] | null | undefined,
  allowOne: (subject: Subject | undefined) => Allowance | undefined,
): Allowance[] | undefined {
  if (!commands) {
    const one = allowOne(commands === null ? undefined : subject);
    return one && [one];
  }
  const found: Allowance[] = [];
  for (const command of commands) {
    if (isFilter(command)) continue;
    const one = allowOne({ type: 'text', value: command.text });
    if (!one) return undefined;
    found.push(one);
  }
  return found.length ? found : undefined;
}

function ruleFor(rules: Rule[], toolName: string, subject: Subject | undefined) {
  const rule = rules.find((candidate) => matches(candidate, toolName, subject));
  return rule && { by: 'rule' as const, text: rule.source };
}

/** Deny and ask rules match a command line when they match it or any of its commands. */
function matchesAny(
  rule: Rule,
  toolName: string,
  subject: Subject | undefined,
  commands: Command[] | null | undefined,
): boolean {
  return (
    matches(rule, toolName, subject) ||
    (commands ?? []).some((command) =>
      matches(rule, toolName, { type: 'text', value: command.text }),
    )
  );
}

function allowReason(allowed: Allowance[]): string {
  const [only, ...rest] = allowed;
  if (only && !rest.length) {
    return only.by === 'grant'
      ? `the user allowed commands starting with "${only.text}" for this session`
      : `it matches the allow rule "${only.text}"`;
  }
  const each = allowed.map(({ by, text }) =>
    by === 'grant' ? `"${text}" for this session` : `the allow rule "${text}"`,
  );
  return `each of its commands is allowed: ${unique(each).join(', ')}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Programs that run arbitrary code or destroy things: never allowed by prefix. */
const EXACT_ONLY = new Set([
  ...['bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'env', 'sudo', 'su', 'xargs'],
  ...['eval', 'exec', 'nohup', 'timeout', 'time', 'watch', 'start', 'ssh', 'scp', 'curl', 'wget'],
  ...['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'java'],
  ...['tsx', 'ts-node', 'cross-env'],
  ...['docker', 'podman', 'kubectl', 'rm', 'rmdir', 'del', 'erase', 'rd', 'mv', 'move', 'dd'],
  ...['chmod', 'chown', 'kill', 'pkill', 'killall', 'taskkill', 'shutdown', 'reboot', 'format'],
]);

/**
 * The leading words of a command that "yes for the session" allows: the program and up to two
 * more words that are subcommands or simple flags (`./mvnw -q test`, `npm run build`, `git
 * status`). None for commands with shell syntax or programs that can run anything.
 */
export function commandPrefix(command: string): string | undefined {
  const text = command.replace(HARMLESS_REDIRECT, '').trim();
  if (!text || !isSimple(text)) return undefined;
  const [program = '', ...rest] = text.split(/\s+/);
  const name = realProgram(program, rest);
  if (name === undefined || EXACT_ONLY.has(name)) return undefined;
  const words = [program];
  for (const word of rest.slice(0, 2)) {
    if (!/^(-{1,2})?[a-z][\w:.-]*$/i.test(word)) break;
    words.push(word);
  }
  return words.join(' ');
}

/** Programs that run the program named next in their arguments (`npx tsx …` runs tsx). */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const RUNNER_SUBCOMMANDS: Record<string, string[]> = {
  npm: ['exec', 'x'],
  pnpm: ['exec', 'dlx'],
  yarn: ['exec', 'dlx'],
  bun: ['x'],
};

function programName(word: string): string {
  return word
    .replace(/^.*[/\\]/, '')
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
}

/** The program a command really runs, looking through runners; undefined when unclear. */
function realProgram(program: string, rest: string[]): string | undefined {
  let name = programName(program);
  let args = rest;
  for (let depth = 0; depth < 3; depth++) {
    const viaSubcommand = RUNNER_SUBCOMMANDS[name]?.includes(args[0] ?? '');
    if (!RUNNERS.has(name) && !viaSubcommand) return name;
    const after = viaSubcommand ? args.slice(1) : args;
    const index = after.findIndex((word) => !word.startsWith('-'));
    if (index === -1) return undefined;
    name = programName(after[index]!);
    args = after.slice(index + 1);
  }
  return undefined;
}

/** A prefix covers one command: itself, or with more arguments; nothing chained or redirected. */
function coversCommand(prefix: string, command: string): boolean {
  const text = command.replace(HARMLESS_REDIRECT, '').trim();
  if (!isSimple(text)) return false;
  return text === prefix || text.startsWith(`${prefix} `);
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
