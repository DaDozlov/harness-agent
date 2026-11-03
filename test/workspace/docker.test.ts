import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bypassNotice } from '../../src/cli/chat/commands.js';
import { setupEngine } from '../../src/cli/setup.js';
import { validateConfig } from '../../src/config/schema.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import {
  credentialHelper,
  DockerWorkspace,
  dockerRunArgs,
  explainDockerError,
  projectLabel,
  READ_ONLY_PATHS,
} from '../../src/workspace/docker.js';
import { collect, tempDirFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const workspaces: DockerWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

function docker(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((done) => {
    execFile('docker', args, { timeout: 300_000, windowsHide: true }, (error, stdout) =>
      done({ ok: !error, stdout: stdout.trim() }),
    );
  });
}

/** Integration tests need a Docker engine that runs Linux containers (CI on Linux, Docker Desktop). */
const dockerReady = (await docker(['info', '--format', '{{.OSType}}'])).stdout === 'linux';
const IMAGE = 'alpine:3.20';

describe('the Docker workspace, without Docker', () => {
  it('builds the docker run arguments', () => {
    expect(
      dockerRunArgs({
        root: '/home/ada/app',
        name: 'heaw-app-abc123',
        image: 'node:24',
        network: 'none',
        cpus: 2,
        memory: '4g',
        envNames: ['GH_TOKEN'],
        user: '1000:1000',
        project: 'p1',
      }),
    ).toEqual([
      'run',
      '--detach',
      '--rm',
      '--init',
      '--name',
      'heaw-app-abc123',
      '--label',
      'heaw=1',
      '--label',
      'heaw.project=p1',
      '--label',
      `heaw.pid=${process.pid}`,
      '--volume',
      '/home/ada/app:/workspace',
      '--workdir',
      '/workspace',
      '--network',
      'none',
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--user',
      '1000:1000',
      '--env',
      'HOME=/tmp/heaw-home',
      '--env',
      'GH_TOKEN',
      '--entrypoint',
      'tail',
      'node:24',
      '-f',
      '/dev/null',
    ]);
  });

  it('mounts protected paths read-only over the project', () => {
    const args = dockerRunArgs({
      root: '/home/ada/app',
      name: 'n',
      image: 'node:24',
      network: 'none',
      envNames: [],
      project: 'p1',
      readOnly: ['heaw.config.ts', '.heaw'],
    });
    const volumes = args.flatMap((arg, index) => (arg === '--volume' ? [args[index + 1]] : []));

    expect(volumes).toEqual([
      '/home/ada/app:/workspace',
      `${join('/home/ada/app', 'heaw.config.ts')}:/workspace/heaw.config.ts:ro`,
      `${join('/home/ada/app', '.heaw')}:/workspace/.heaw:ro`,
    ]);
    expect(READ_ONLY_PATHS).toEqual(
      expect.arrayContaining(['heaw.config.ts', '.mcp.json', '.heaw', '.git/hooks']),
    );
  });

  it('writes a credential helper that reads the token when git asks, and never stores it', () => {
    expect(credentialHelper('GH_TOKEN')).toBe(
      '!f() { test "$1" = get || exit 0; echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f',
    );
    expect(() => credentialHelper('not a name; rm -rf /')).toThrow('is not a variable name');
  });

  it('describes itself to the model and maps /workspace paths to the project', async () => {
    const root = await tempDir();
    const workspace = new DockerWorkspace(root, { image: 'python:3.13' });

    await workspace.writeFile('/workspace/notes/a.txt', 'hello');

    expect(await readFile(join(root, 'notes', 'a.txt'), 'utf8')).toBe('hello');
    expect(workspace.displayPath('/workspace/notes/a.txt')).toBe('notes/a.txt');
    expect(() => workspace.resolve('/etc/passwd')).toThrow('outside the workspace');
    expect(workspace.kind).toBe('docker');
    expect(workspace.shell).toBe('bash (in a Docker container, image python:3.13)');
    expect(workspace.description).toContain('mounted at /workspace');
    expect(workspace.description).toContain('Commands have no network access');
    expect(new DockerWorkspace(root, { network: 'bridge' }).description).toContain(
      'Commands have network access (bridge).',
    );
  });

  it('refuses a git token variable the container would not get', async () => {
    const root = await tempDir();
    expect(() => new DockerWorkspace(root, { git: { tokenEnv: 'GH_TOKEN' } })).toThrow(
      'add it to workspace.env',
    );
  });

  it('turns a missing or stopped Docker into advice, as command output', async () => {
    const workspace = new DockerWorkspace(await tempDir(), { command: 'no-such-docker-cli' });
    workspaces.push(workspace);

    const result = await workspace.exec('echo hi');

    expect(result.exitCode).toBeNull();
    expect(result.output).toBe(
      "The Docker workspace could not start: no-such-docker-cli was not found. Install Docker Desktop or Docker Engine (or Podman, with workspace.command: 'podman'), or use the local workspace.",
    );
    expect(
      explainDockerError(
        'docker',
        'node:24',
        'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine',
      ),
    ).toBe(
      'docker is installed but not running. Start Docker Desktop (or the docker service) and try again.',
    );
    expect(
      explainDockerError(
        'docker',
        'nope:1',
        "Unable to find image 'nope:1' locally\npull access denied",
      ),
    ).toContain('the image "nope:1" could not be found or pulled');
  });

  it('tells the model where commands run', async () => {
    const model = new ScriptedModelClient([{ text: 'ok' }]);
    const workspace = new DockerWorkspace(await tempDir(), { command: 'no-such-docker-cli' });
    const engine = await createEngine({ model, workspace, toolsets: ['shell'], git: false });

    await collect(engine.session().send('hi'));
    await engine.dispose();

    expect(model.requests[0]?.system).toContain('Workspace: docker');
    expect(model.requests[0]?.system).toContain(
      'Commands run in a Docker container (image node:24)',
    );
  });

  it('checks the workspace config', async () => {
    expect(() => validateConfig({ workspace: { image: 'node:24' } }, 'heaw.config.ts')).toThrow(
      "workspace.image: only used with type: 'docker'",
    );
    expect(() =>
      validateConfig({ workspace: { type: 'docker', shell: 'bash' } }, 'heaw.config.ts'),
    ).toThrow("workspace.shell: only for type 'local'");
    expect(
      validateConfig({ workspace: { type: 'docker', network: 'bridge', cpus: 2 } }, 'f'),
    ).toBeTruthy();

    const root = await tempDir();
    await writeFile(
      join(root, 'heaw.config.ts'),
      "export default { model: 'azure:x', workspace: { type: 'docker', git: { tokenEnv: 'GH_TOKEN' } } };",
    );
    await expect(
      setupEngine(
        {},
        {
          cwd: root,
          env: { HEAW_HOME: join(root, 'home') },
          interactive: false,
          packageEntry: resolve('src/index.ts'),
        },
      ),
    ).rejects.toThrow("Add it to workspace.env, e.g. env: { GH_TOKEN: env('GH_TOKEN') }.");
  });

  it('does not warn about bypass mode inside a container', () => {
    expect(bypassNotice('docker').tone).toBe('info');
    expect(bypassNotice('local')).toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('only in a container') as unknown,
    });
  });
});

describe.skipIf(!dockerReady)('the Docker workspace, with Docker', () => {
  beforeAll(async () => {
    await docker(['pull', IMAGE]);
    await docker(['pull', 'alpine/git']);
  }, 600_000);

  async function workspace(options: ConstructorParameters<typeof DockerWorkspace>[1] = {}) {
    const root = await tempDir();
    const created = new DockerWorkspace(root, { image: IMAGE, ...options });
    workspaces.push(created);
    return { root, workspace: created };
  }

  it('runs commands in the container, on the mounted project', async () => {
    const { root, workspace: box } = await workspace();
    await writeFile(join(root, 'from-host.txt'), 'host');

    const result = await box.exec('pwd; cat from-host.txt; echo container > from-box.txt; exit 3');

    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.output).toBe('/workspace\nhost');
    expect(await readFile(join(root, 'from-box.txt'), 'utf8')).toBe('container\n');
    // Alpine has no bash.
    expect(box.shell).toBe(`sh (in a Docker container, image ${IMAGE})`);
    await box.writeFile('sub/x.txt', '');
    expect((await box.exec('pwd', { cwd: 'sub' })).output).toBe('/workspace/sub\n');
  }, 120_000);

  it("keeps heaw's own files and git hooks read-only for commands", async () => {
    const { root, workspace: box } = await workspace();
    await writeFile(join(root, 'heaw.config.ts'), 'export default {};');
    await mkdir(join(root, '.heaw', 'agents'), { recursive: true });
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });

    const result = await box.exec(
      [
        '{ echo pwned > heaw.config.ts; } 2>/dev/null || echo config-protected',
        'touch .heaw/agents/evil.md 2>/dev/null || echo heaw-protected',
        'touch .git/hooks/pre-commit 2>/dev/null || echo hooks-protected',
        'echo ok > src.txt && echo project-writable',
      ].join('; '),
    );

    expect(result.output).toBe(
      'config-protected\nheaw-protected\nhooks-protected\nproject-writable\n',
    );
    expect(await readFile(join(root, 'heaw.config.ts'), 'utf8')).toBe('export default {};');
  }, 120_000);

  it('passes only the configured variables, and has no network by default', async () => {
    process.env.HEAW_TEST_HOST_SECRET = 'leaked';
    const { workspace: box } = await workspace({ env: { VISIBLE: 'yes' } });

    const result = await box.exec(
      'echo "$VISIBLE-$HEAW_TEST_HOST_SECRET"; wget -q -T 3 -O /dev/null http://example.com 2>/dev/null && echo online || echo offline',
    );

    expect(result.output).toBe('yes-\noffline\n');
    delete process.env.HEAW_TEST_HOST_SECRET;
  }, 120_000);

  it('stops a command and everything it started, inside the container', async () => {
    const { workspace: box } = await workspace();

    const result = await box.exec('sleep 300 & sleep 300', { timeoutMs: 1_500 });
    await new Promise((done) => setTimeout(done, 4_000));
    const left = await box.exec('ps -o args | grep -c "[s]leep 300" || true');

    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(left.output.trim()).toBe('0');
  }, 120_000);

  it('sets up git: a trusted repository, the author, and HTTPS credentials from a variable', async () => {
    const { workspace: box } = await workspace({
      image: 'alpine/git',
      env: { GH_TOKEN: 't0ken' },
      git: { tokenEnv: 'GH_TOKEN', name: 'Ada Lovelace', email: 'ada@example.com' },
    });

    const result = await box.exec(
      'git init -q && git status --short && git config user.name && ' +
        "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Ada Lovelace');
    expect(result.output).toContain('username=x-access-token\npassword=t0ken');
    expect(result.output).not.toContain('dubious ownership');
  }, 180_000);

  it('removes its container when closed, and containers left behind by a crashed heaw', async () => {
    const { root, workspace: box } = await workspace();
    const label = projectLabel(root);
    const leftover = await docker([
      'run',
      '-d',
      '--label',
      'heaw=1',
      '--label',
      `heaw.project=${label}`,
      '--label',
      'heaw.pid=999999',
      '--entrypoint',
      'tail',
      IMAGE,
      '-f',
      '/dev/null',
    ]);
    const containers = async () =>
      (
        await docker(['ps', '-a', '--filter', `label=heaw.project=${label}`, '--format', '{{.ID}}'])
      ).stdout
        .split('\n')
        .filter(Boolean);

    await box.prepare();
    const running = await containers();
    await box.dispose();

    expect(leftover.ok).toBe(true);
    expect(running).toHaveLength(1);
    expect(running[0]).not.toBe(leftover.stdout.slice(0, 12));
    expect(await containers()).toEqual([]);
  }, 120_000);
});
