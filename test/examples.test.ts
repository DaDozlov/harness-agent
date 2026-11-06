import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Hooks } from '../src/core/hooks.js';
import { loadEvalCases } from '../src/evals/cases.js';
import { loadProject } from '../src/project.js';
import { LocalWorkspace } from '../src/workspace/local.js';
import { tempDirFactory } from './helpers.js';

const tempDir = tempDirFactory();
const PACKAGE_ENTRY = resolve('src/index.ts');
const EXAMPLES = resolve('examples');

/** An example set up as `heaw` would, with placeholder credentials and no personal config. */
async function load(name: string) {
  return loadProject({
    cwd: join(EXAMPLES, name),
    env: {
      HEAW_HOME: await tempDir(),
      GITHUB_TOKEN: 'github-token-0123',
      SHOP_API_TOKEN: 'dev-token',
    },
    packageEntry: PACKAGE_ENTRY,
    save: false,
  });
}

describe('examples', () => {
  it('github-jira: config, MCP servers, agent and skill load as heaw would load them', async () => {
    const { options, loaded, warnings } = await load('github-jira');

    expect(warnings).toEqual([]);
    expect(loaded.projectRoot).toBe(join(EXAMPLES, 'github-jira'));
    expect(options.workspace?.kind).toBe('docker');
    expect(options.mcp?.servers.map((server) => [server.name, server.config])).toEqual([
      ['github', expect.objectContaining({ url: 'https://api.githubcopilot.com/mcp/' })],
      ['atlassian', expect.objectContaining({ oauth: true })],
    ]);
    expect(options.agents?.map((agent) => [agent.name, agent.mode])).toEqual([
      ['reviewer', 'read-only'],
    ]);
    expect(options.skills?.map((skill) => skill.name)).toEqual([
      'setup-harness',
      'plan-work',
      'retro',
      'implement-story',
    ]);
    expect(options.permissions?.deny).toContain('mcp__github__merge_pull_request');
    expect(options.instructions?.map((file) => file.source)).toEqual(['AGENTS.md']);
  });

  it('coding-agent: config and eval cases load, and the fixture has exactly its one bug', async () => {
    const { options, warnings, loaded } = await load('coding-agent');
    const evals = await loadEvalCases(join(loaded.projectRoot, 'evals'));

    expect(warnings).toEqual([]);
    expect(options.hooks).toBeDefined();
    expect(evals.problems).toEqual([]);
    expect(evals.items.map((evalCase) => evalCase.name)).toEqual([
      'add-median',
      'fix-failing-test',
    ]);

    const fixture = evals.items[0]!.fixture!;
    const tests = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=spec'], {
      cwd: fixture,
    }).catch((error: { stdout: string }) => error);
    expect(tests.stdout).toMatch(/ℹ pass 3\b/);
    expect(tests.stdout).toMatch(/ℹ fail 1\b/);
  });

  it('business-agent: only the API and skills, and refunds over the limit go to a person', async () => {
    const { options, warnings } = await load('business-agent');
    const [hooks] = [options.hooks].flat() as Hooks[];
    const refund = (amount: number) =>
      hooks!.beforeToolCall!({
        sessionId: 's',
        agentId: 'main',
        model: 'azure:gpt-5.4',
        workspace: new LocalWorkspace(EXAMPLES),
        signal: new AbortController().signal,
        tool: 'http_request',
        callId: 'c',
        args: { method: 'POST', url: 'http://localhost:4010/refunds', json: { amount } },
      });

    expect(warnings).toEqual([]);
    expect(options.toolsets).toEqual(['http', 'skills', 'todo']);
    expect(Object.keys(options.http?.apis ?? {})).toEqual(['http://localhost:4010']);
    expect(options.skills?.map((skill) => skill.name).sort()).toEqual(['deliveries', 'refunds']);
    expect(await refund(89)).toBeUndefined();
    const blocked = (await refund(240)) as { block?: string } | undefined;
    expect(blocked?.block).toContain('need a person');
  });
});
