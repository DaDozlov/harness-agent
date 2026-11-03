import { describe, expect, it } from 'vitest';
import { formatGitSummary, gitSummary, parseGitStatus } from '../../src/core/git.js';
import { tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

describe('git summary', () => {
  it('parses branch and changes from git status', () => {
    expect(parseGitStatus('## main...origin/main [ahead 1]\n M src/a.ts\n?? notes.md\n')).toEqual({
      branch: 'main',
      changes: ['M src/a.ts', '?? notes.md'],
    });
    expect(parseGitStatus('## No commits yet on main\n')).toEqual({ branch: 'main', changes: [] });
    expect(parseGitStatus('## HEAD (no branch)\n')).toEqual({ branch: undefined, changes: [] });
  });

  it('formats a short line, listing a few changes', () => {
    expect(formatGitSummary({ branch: 'main', changes: [] })).toBe(
      'branch main, no uncommitted changes',
    );
    const many = Array.from({ length: 10 }, (_, i) => `M f${i}.ts`);
    expect(formatGitSummary({ branch: 'dev', changes: many })).toBe(
      'branch dev, 10 uncommitted changes: M f0.ts, M f1.ts, M f2.ts, M f3.ts, M f4.ts, M f5.ts, M f6.ts, M f7.ts, and 2 more',
    );
  });

  it('reads a real repository, and nothing outside one', async () => {
    const workspace = await tempWorkspace();
    expect(await gitSummary(workspace)).toBeUndefined();

    await workspace.exec('git init -q -b trunk');
    await workspace.writeFile('new.txt', 'x');

    expect(await gitSummary(workspace)).toEqual({ branch: 'trunk', changes: ['?? new.txt'] });
  });
});
