import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** How `exec` runs a command. */
export interface ShellSpec {
  /** Shown to the model, e.g. `bash (Git Bash)`. */
  name: string;
  file: string;
  args(command: string): string[];
}

type Env = Record<string, string | undefined>;

/**
 * Picks the shell for commands: `HEAW_SHELL` if set; on Windows Git Bash if installed (models
 * write bash far more reliably than PowerShell), otherwise PowerShell; elsewhere the user's bash
 * or zsh, falling back to /bin/sh.
 */
export function detectShell(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): ShellSpec {
  const override = env.HEAW_SHELL?.trim();
  if (override) return shellAt(override, platform);
  if (platform === 'win32') return findGitBash(env) ?? powerShell('powershell.exe');
  const shell = env.SHELL && /\/(bash|zsh)$/.test(env.SHELL) ? env.SHELL : undefined;
  return posixShell(shell ?? (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'));
}

function shellAt(file: string, platform: NodeJS.Platform): ShellSpec {
  const name = basename(file).toLowerCase();
  if (name.startsWith('powershell') || name.startsWith('pwsh')) return powerShell(file);
  if (platform === 'win32' && /\\git\\/i.test(file))
    return { ...posixShell(file), name: 'bash (Git Bash)' };
  return posixShell(file);
}

function posixShell(file: string): ShellSpec {
  return { name: basename(file).replace(/\.exe$/i, ''), file, args: (command) => ['-c', command] };
}

/**
 * Git for Windows installs `bin\bash.exe` next to `cmd\git.exe`. Searching PATH for `bash` would
 * be wrong: `WindowsApps\bash.exe` is the WSL launcher.
 */
function findGitBash(env: Env): ShellSpec | undefined {
  const roots = gitRootsOnPath(env.PATH ?? env.Path ?? '');
  for (const programFiles of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (programFiles) roots.push(join(programFiles, 'Git'));
  }
  if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', 'Git'));

  for (const root of roots) {
    const bash = join(root, 'bin', 'bash.exe');
    if (existsSync(bash)) return { ...posixShell(bash), name: 'bash (Git Bash)' };
  }
  return undefined;
}

function gitRootsOnPath(path: string): string[] {
  const roots: string[] = [];
  for (const dir of path.split(';')) {
    if (!dir || !existsSync(join(dir, 'git.exe'))) continue;
    // git.exe lives in <root>\cmd, <root>\bin or <root>\mingw64\bin.
    roots.push(dirname(dir), dirname(dirname(dir)));
  }
  return roots;
}

/**
 * The command travels Base64-encoded, so no quoting rules can mangle it. The wrapper makes
 * PowerShell print UTF-8 and exit with the failing command's exit code.
 */
function powerShell(file: string): ShellSpec {
  return {
    name: basename(file).toLowerCase().startsWith('pwsh') ? 'PowerShell 7' : 'Windows PowerShell',
    file,
    args: (command) => {
      const script = [
        "$ProgressPreference = 'SilentlyContinue'",
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        command,
        '$heawOk = $?',
        'if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        'if (-not $heawOk) { exit 1 }',
      ].join('\n');
      return [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ];
    },
  };
}
