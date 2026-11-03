import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../src/core/workspace.js';
import { LocalWorkspace } from '../../src/workspace/local.js';
import { detectShell } from '../../src/workspace/shell.js';
import { tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();

describe('LocalWorkspace paths', () => {
  it('resolves paths inside the root and rejects paths outside it', async () => {
    const workspace = await tempWorkspace();

    expect(workspace.resolve('src/a.ts')).toBe(join(workspace.root, 'src', 'a.ts'));
    expect(workspace.resolve(join(workspace.root, 'b.ts'))).toBe(join(workspace.root, 'b.ts'));
    expect(workspace.resolve('..foo')).toBe(join(workspace.root, '..foo'));
    expect(() => workspace.resolve('../escape.txt')).toThrow(WorkspaceError);
    expect(() => workspace.resolve('src/../../escape.txt')).toThrow(WorkspaceError);
    expect(() => workspace.resolve(join(workspace.root, '..', 'other'))).toThrow(WorkspaceError);
  });

  it('shows paths relative to the root with forward slashes', async () => {
    const workspace = await tempWorkspace();

    expect(workspace.displayPath(join(workspace.root, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(workspace.displayPath(join('src', 'b.ts'))).toBe('src/b.ts');
    expect(workspace.displayPath('.')).toBe('.');
    expect(workspace.displayPath('../x')).not.toMatch(/^\.\./);
  });
});

describe('LocalWorkspace files', () => {
  it('writes files, creating folders, then reads, stats and lists them', async () => {
    const workspace = await tempWorkspace();

    await workspace.writeFile('deep/folder/note.txt', 'hello');

    expect((await workspace.readFile('deep/folder/note.txt')).toString()).toBe('hello');
    expect(await workspace.stat('deep/folder/note.txt')).toMatchObject({ isFile: true, size: 5 });
    expect(await workspace.stat('missing.txt')).toBeUndefined();
    expect(await workspace.list('deep')).toEqual([{ name: 'folder', isDirectory: true }]);
  });
});

describe('LocalWorkspace exec', () => {
  it(`runs commands in ${detectShell().name} and reports the exit code`, async () => {
    const workspace = await tempWorkspace();

    const ok = await workspace.exec('echo hello');
    const failed = await workspace.exec('exit 3');

    expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
    expect(ok.output.trim()).toBe('hello');
    expect(failed.exitCode).toBe(3);
  });

  it('captures stderr and runs in the given folder', async () => {
    const workspace = await tempWorkspace();
    await workspace.writeFile('sub/marker.txt', 'x');

    const result = await workspace.exec(
      "node -e \"console.error('oops'); console.log(require('fs').existsSync('marker.txt'))\"",
      { cwd: 'sub' },
    );

    expect(result.output).toContain('oops');
    expect(result.output).toContain('true');
  });

  it('stops a command at the timeout, including the processes it started', async () => {
    const workspace = await tempWorkspace();
    // The shell starts node, which records its pid and waits: killing only the shell would
    // leave node running.
    await workspace.writeFile(
      'child.js',
      "require('fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 60000);",
    );

    const started = Date.now();
    const result = await workspace.exec('node child.js', { timeoutMs: 1_500 });

    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    const childPid = Number(await readFile(join(workspace.root, 'child.pid'), 'utf8'));
    await expect.poll(() => isRunning(childPid), { timeout: 5_000 }).toBe(false);
  });

  it('stops a command when the signal aborts', async () => {
    const workspace = await tempWorkspace();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const result = await workspace.exec('node -e "setTimeout(() => {}, 60000)"', {
      signal: controller.signal,
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});

describe('LocalWorkspace ripgrep', () => {
  it('runs the bundled ripgrep in the root', async () => {
    const workspace = await tempWorkspace();
    await workspace.writeFile('a.txt', 'needle\n');

    const result = await workspace.ripgrep(['--files-with-matches', 'needle']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('a.txt');
  });
});

describe('detectShell', () => {
  it('honours HEAW_SHELL', () => {
    expect(detectShell({ HEAW_SHELL: '/usr/bin/zsh' }, 'linux')).toMatchObject({
      name: 'zsh',
      file: '/usr/bin/zsh',
    });
    expect(detectShell({ HEAW_SHELL: 'pwsh' }, 'win32').name).toBe('PowerShell 7');
  });

  it('falls back to Windows PowerShell when Git Bash is not installed', () => {
    const shell = detectShell({ PATH: '' }, 'win32');
    expect(shell.name).toBe('Windows PowerShell');
    expect(shell.args('echo hi')).toContain('-EncodedCommand');
  });

  it.runIf(process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe'))(
    'finds Git Bash through git.exe, not the WSL launcher',
    () => {
      expect(detectShell()).toMatchObject({
        name: 'bash (Git Bash)',
        file: expect.stringMatching(/Git\\bin\\bash\.exe$/i) as unknown,
      });
    },
  );
});

describe.runIf(process.platform === 'win32')('LocalWorkspace with Windows PowerShell', () => {
  const powershellWorkspace = async () => {
    const temp = await tempWorkspace();
    return new LocalWorkspace(temp.root, {
      shell: detectShell({ HEAW_SHELL: 'powershell.exe' }, 'win32'),
    });
  };

  it('passes exit codes of native commands, cmdlets and exit through', async () => {
    const workspace = await powershellWorkspace();

    expect((await workspace.exec('Write-Output hi')).output.trim()).toBe('hi');
    expect((await workspace.exec('exit 4')).exitCode).toBe(4);
    expect((await workspace.exec('node -e "process.exit(5)"')).exitCode).toBe(5);
    expect((await workspace.exec('Get-Item does-not-exist')).exitCode).toBe(1);
  });

  it('keeps quotes intact and prints UTF-8', async () => {
    const workspace = await powershellWorkspace();

    const result = await workspace.exec(`Write-Output "say \`"Grüße\`" and 'hi'"`);

    expect(result.output.trim()).toBe(`say "Grüße" and 'hi'`);
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
