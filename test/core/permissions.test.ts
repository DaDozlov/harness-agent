import { describe, expect, it } from 'vitest';
import {
  PermissionPolicy,
  PermissionRuleError,
  type Subject,
  suggestRule,
} from '../../src/core/permissions.js';
import type { ToolKind } from '../../src/core/tools.js';

const tool = (name: string, kind: ToolKind) => ({ name, kind });
const path = (value: string): Subject => ({ value, type: 'path' });
const text = (value: string): Subject => ({ value, type: 'text' });

const READ = tool('read_file', 'read');
const WRITE = tool('write_file', 'write');
const RUN = tool('run_command', 'execute');
const FETCH = tool('web_fetch', 'network');

describe('PermissionPolicy modes', () => {
  it.each([
    ['default', ['allow', 'ask', 'ask', 'ask']],
    ['accept-edits', ['allow', 'allow', 'ask', 'ask']],
    ['read-only', ['allow', 'deny', 'deny', 'ask']],
    ['bypass', ['allow', 'allow', 'allow', 'allow']],
  ] as const)('%s mode decides read, write, execute, network as %j', (mode, expected) => {
    const policy = new PermissionPolicy({ mode });
    const decisions = [READ, WRITE, RUN, FETCH].map((t) => policy.check(t, undefined).decision);
    expect(decisions).toEqual(expected);
  });

  it('explains a mode decision', () => {
    expect(new PermissionPolicy().check(RUN, text('ls')).reason).toBe(
      'execute actions are set to "ask" in default mode',
    );
  });

  it('rejects an unknown mode', () => {
    expect(() => new PermissionPolicy({ mode: 'yolo' as never })).toThrow(PermissionRuleError);
  });
});

describe('PermissionPolicy rules', () => {
  it('matches command patterns as text with * wildcards', () => {
    const policy = new PermissionPolicy({ allow: ['run_command(npm test*)'] });

    expect(policy.check(RUN, text('npm test')).decision).toBe('allow');
    expect(policy.check(RUN, text('npm test -- --watch=false src/a.test.ts')).decision).toBe(
      'allow',
    );
    expect(policy.check(RUN, text('npm install')).decision).toBe('ask');
    expect(policy.check(RUN, text('echo x && npm test')).decision).toBe('ask');
  });

  it('matches path patterns as globs', () => {
    const policy = new PermissionPolicy({
      allow: ['write_file(src/**)'],
      deny: ['read_file(**/.env*)'],
    });

    expect(policy.check(WRITE, path('src/a/b.ts')).decision).toBe('allow');
    expect(policy.check(WRITE, path('test/a.ts')).decision).toBe('ask');
    expect(policy.check(READ, path('.env')).decision).toBe('deny');
    expect(policy.check(READ, path('config/.env.local')).decision).toBe('deny');
    expect(policy.check(READ, path('src/env.ts')).decision).toBe('allow');
  });

  it('applies deny, then ask, then allow, then the mode', () => {
    const policy = new PermissionPolicy({
      mode: 'bypass',
      allow: ['run_command(git *)'],
      ask: ['run_command(git push*)'],
      deny: ['run_command(git push --force*)'],
    });

    expect(policy.check(RUN, text('git status')).decision).toBe('allow');
    expect(policy.check(RUN, text('git push origin main')).decision).toBe('ask');
    expect(policy.check(RUN, text('git push --force')).reason).toBe(
      'it matches the deny rule "run_command(git push --force*)"',
    );
  });

  it('supports * in tool names and rules without a pattern', () => {
    const policy = new PermissionPolicy({
      allow: ['mcp__github__get_*'],
      deny: ['mcp__github__delete_*', 'write_file'],
    });

    expect(policy.check(tool('mcp__github__get_issue', 'execute'), undefined).decision).toBe(
      'allow',
    );
    expect(policy.check(tool('mcp__github__delete_repo', 'execute'), undefined).decision).toBe(
      'deny',
    );
    expect(policy.check(WRITE, path('anything.txt')).decision).toBe('deny');
  });

  it('never matches a pattern rule against a call without a subject', () => {
    const policy = new PermissionPolicy({ deny: ['mcp__jira__search(*)'] });
    expect(policy.check(tool('mcp__jira__search', 'read'), undefined).decision).toBe('allow');
  });

  it('allows an approved call for the rest of the session, but deny rules still win', () => {
    const policy = new PermissionPolicy({ deny: ['run_command(rm *)'] });

    policy.allowForSession('run_command', text('npm test'));
    policy.allowForSession('run_command', text('rm -rf build'));

    expect(policy.check(RUN, text('npm test')).decision).toBe('allow');
    expect(policy.check(RUN, text('npm test --coverage')).decision).toBe('ask');
    expect(policy.check(RUN, text('rm -rf build')).decision).toBe('deny');
  });

  it("always asks before changing heaw's own files, in every mode and despite allow rules", () => {
    const bypass = new PermissionPolicy({ mode: 'bypass', allow: ['write_file(**)'] });
    const EDIT = tool('edit_file', 'write');

    for (const file of [
      'heaw.config.ts',
      '.mcp.json',
      '.heaw/agents/x.md',
      '.git/hooks/pre-commit',
    ]) {
      expect(bypass.check(WRITE, path(file))).toEqual({
        decision: 'ask',
        reason: `it changes ${file}, which controls heaw itself, so it is always asked about`,
      });
    }
    expect(bypass.check(EDIT, path('src/heaw.config.ts')).decision).toBe('allow');
    expect(bypass.check(READ, path('heaw.config.ts')).decision).toBe('allow');
    expect(
      new PermissionPolicy({ mode: 'read-only' }).check(WRITE, path('.mcp.json')).decision,
    ).toBe('deny');
    expect(
      new PermissionPolicy({ deny: ['write_file(.heaw/**)'] }).check(WRITE, path('.heaw/a'))
        .decision,
    ).toBe('deny');
    expect(
      new PermissionPolicy({ mode: 'bypass', preapproved: ['write_file(.mcp.json)'] }).check(
        WRITE,
        path('.mcp.json'),
      ).decision,
    ).toBe('allow');
    bypass.allowForSession('write_file', path('heaw.config.ts'));
    expect(bypass.check(WRITE, path('heaw.config.ts')).decision).toBe('allow');
  });

  it('lets rules allowed in advance cover what ask rules ask about, but not what deny rules deny', () => {
    const policy = new PermissionPolicy({
      allow: ['run_command(git *)'],
      ask: ['run_command(git push*)'],
      deny: ['run_command(git push --force*)'],
      preapproved: ['run_command(git push*)'],
    });

    expect(policy.check(RUN, text('git push -u origin HEAD'))).toEqual({
      decision: 'allow',
      reason: 'it was allowed in advance by "run_command(git push*)"',
    });
    expect(policy.check(RUN, text('git push --force')).decision).toBe('deny');
    expect(
      new PermissionPolicy({
        allow: ['run_command(git *)'],
        ask: ['run_command(git push*)'],
      }).check(RUN, text('git push')).decision,
    ).toBe('ask');
    expect(policy.allowRulesFor('run_command')).toEqual([
      'run_command(git push*)',
      'run_command(git *)',
    ]);
  });

  it.each(['', 'run_command()', 'bad name(x)', 'run_command(x'])(
    'rejects the rule "%s"',
    (rule) => {
      expect(() => new PermissionPolicy({ allow: [rule] })).toThrow(PermissionRuleError);
    },
  );
});

describe('suggestRule', () => {
  it('suggests a rule for exactly this call', () => {
    expect(suggestRule('run_command', text('npm test'))).toBe('run_command(npm test)');
    expect(suggestRule('mcp__jira__search', undefined)).toBe('mcp__jira__search');
  });
});
