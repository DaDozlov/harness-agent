/** Variable names that usually hold secrets. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|(^|_)PAT($|_)/i;
/** Names that look like secrets but are needed and are none: an SSH agent's socket, X11 auth. */
const NOT_SECRET = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'XAUTHORITY', 'GPG_AGENT_INFO']);

/** Whether a variable's name says it holds a secret (API keys, tokens, passwords). */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) && !NOT_SECRET.has(name.toUpperCase());
}
/** Shorter values would match ordinary words and numbers. */
const MIN_SECRET_LENGTH = 8;
const MARK = '[redacted]';

/**
 * Replaces known secret values in text before it is written to logs or sent to traces
 * (docs/DESIGN.md §4.14), e.g. an API key that a command printed.
 */
export class Redactor {
  readonly #secrets: string[];

  constructor(secrets: Iterable<string>) {
    const forms = new Set<string>();
    for (const secret of secrets) {
      if (secret.length < MIN_SECRET_LENGTH) continue;
      forms.add(secret);
      // Inside JSON, quotes and backslashes in a secret are escaped.
      forms.add(JSON.stringify(secret).slice(1, -1));
    }
    // Longest first, so a secret that contains another is replaced whole.
    this.#secrets = [...forms].sort((a, b) => b.length - a.length);
  }

  /** How many distinct values it looks for. */
  get size(): number {
    return this.#secrets.length;
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.#secrets) {
      if (result.includes(secret)) result = result.split(secret).join(MARK);
    }
    return result;
  }
}

/**
 * The secret values among environment variables: those whose names look secret (API_KEY,
 * GITHUB_TOKEN, …) and those named in `referenced`, e.g. every variable the config reads.
 */
export function secretsFromEnv(
  env: Record<string, string | undefined>,
  referenced: Iterable<string> = [],
): string[] {
  const names = new Set(referenced);
  for (const name of Object.keys(env)) if (isSecretName(name)) names.add(name);
  return [...names].flatMap((name) => {
    const value = env[name]?.trim();
    return value ? [value] : [];
  });
}

/**
 * Variable names a config reads: `env('NAME')` references, and `${NAME}` / `${NAME:-default}`
 * in strings (as in .mcp.json).
 */
export function referencedVariables(
  value: unknown,
  found = new Set<string>(),
  seen = new Set<object>(),
): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([A-Za-z_]\w*)(?::-[^}]*)?\}/g)) found.add(match[1]!);
    return found;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  const record = value as Record<string, unknown>;
  // env('NAME') in config is { kind: 'env', name, prefix }.
  if (record.kind === 'env' && typeof record.name === 'string') found.add(record.name);
  for (const item of Array.isArray(value) ? value : Object.values(record)) {
    referencedVariables(item, found, seen);
  }
  return found;
}
