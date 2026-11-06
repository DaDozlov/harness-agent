import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AgentDefinition,
  loadAgentDefinitions,
  parseAgentDefinition,
  parseFrontmatter,
} from '../../src/agents/definitions.js';
import { initCommand } from '../../src/cli/commands/init.js';
import type { EngineEvent } from '../../src/core/events.js';
import { textOf } from '../../src/core/messages.js';
import type { ModelClient, ModelRequest, ModelStreamEvent } from '../../src/core/model.js';
import { PermissionPolicy } from '../../src/core/permissions.js';
import { createEngine, type EngineOptions } from '../../src/engine.js';
import { ScriptedModelClient, type ScriptedResponse } from '../../src/providers/scripted.js';
import { JsonlSessionStore } from '../../src/sessions/jsonl-store.js';
import { loadSkills } from '../../src/skills/skills.js';
import { collect, tempDirFactory, tempWorkspaceFactory } from '../helpers.js';

const tempDir = tempDirFactory();
const tempWorkspace = tempWorkspaceFactory();

const reviewer: AgentDefinition = {
  name: 'reviewer',
  description: 'Reviews code for bugs.',
  prompt: 'You review code. Report bugs with file:line.',
  tools: ['read_file', 'grep'],
  source: 'test',
};

async function engineWith(responses: ScriptedResponse[], options: Partial<EngineOptions> = {}) {
  const model = new ScriptedModelClient(responses);
  const workspace = await tempWorkspace();
  await workspace.writeFile('app.ts', 'export const answer = 41;\n');
  const engine = await createEngine({
    model,
    workspace,
    toolsets: ['fs', 'agents'],
    interactive: false,
    git: false,
    agents: [reviewer],
    ...options,
  });
  return { model, engine, workspace };
}

const ofType = <T extends EngineEvent['type']>(events: EngineEvent[], type: T) =>
  events.filter((event): event is Extract<EngineEvent, { type: T }> => event.type === type);
const delegate = (args: Record<string, unknown>, id = 'd1'): ScriptedResponse => ({
  toolCalls: [{ name: 'delegate', args, id }],
});
const lastToolOutput = (request: ModelRequest | undefined) => {
  const message = request?.messages.at(-1);
  return message?.role === 'tool' ? message.content.map((part) => part.output).join('\n') : '';
};

describe('agent definitions', () => {
  it('reads front matter, including files written for Claude Code', () => {
    const { definition, notes } = parseAgentDefinition(
      [
        '---',
        'name: reviewer',
        'description: Reviews code.',
        'tools: Read, Grep, Bash',
        'model: sonnet',
        'mode: read-only',
        'maxTurns: 20',
        '---',
        'You review code.',
      ].join('\n'),
      '/x/reviewer.md',
    );

    expect(definition).toEqual({
      name: 'reviewer',
      description: 'Reviews code.',
      prompt: 'You review code.',
      tools: ['read_file', 'grep', 'run_command'],
      mode: 'read-only',
      limits: { maxTurns: 20 },
      source: '/x/reviewer.md',
    });
    expect(notes).toEqual([
      'model "sonnet" is not provider:model, so it is ignored (subagents.model or the calling agent\'s model is used).',
    ]);
  });

  it('takes the name from the file, and refuses definitions it cannot use', () => {
    expect(
      parseAgentDefinition('---\ndescription: d\n---\nP', '/x/planner.md').definition.name,
    ).toBe('planner');
    expect(() => parseAgentDefinition('---\nname: x\n---\nP', 'x.md')).toThrow('no description');
    expect(() => parseAgentDefinition('---\ndescription: d\nmode: yolo\n---', 'x.md')).toThrow(
      'mode must be',
    );
    expect(() => parseAgentDefinition('---\ndescription: d\nmaxTurns: -1\n---', 'x.md')).toThrow(
      'maxTurns',
    );
    expect(() =>
      parseAgentDefinition('---\ndescription: d\nreasoningEffort: max\n---', 'x.md'),
    ).toThrow('reasoningEffort must be one of low, medium, high');
    expect(
      parseAgentDefinition(
        '---\ndescription: d\nreasoningEffort: high\nmodel: inherit\n---',
        'x.md',
      ).definition,
    ).toMatchObject({ reasoningEffort: 'high', model: 'inherit' });
    expect(parseFrontmatter(`${String.fromCharCode(0xfeff)}---\r\na: 1\r\n---\r\nbody`)).toEqual({
      data: { a: 1 },
      body: 'body',
    });
    expect(parseFrontmatter('no front matter')).toEqual({ data: {}, body: 'no front matter' });
  });

  it('loads personal and project agents, the project winning, and reports bad files', async () => {
    const root = await tempDir();
    const home = join(root, 'home');
    await mkdir(join(home, 'agents'), { recursive: true });
    await mkdir(join(root, '.heaw', 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'helper.md'), '---\ndescription: Personal.\n---\nP');
    await writeFile(
      join(home, 'agents', 'reviewer.md'),
      '---\ndescription: Personal reviewer.\n---\nP',
    );
    await writeFile(
      join(root, '.heaw', 'agents', 'reviewer.md'),
      '---\ndescription: Project reviewer.\n---\nP',
    );
    await writeFile(join(root, '.heaw', 'agents', 'broken.md'), '---\nname: broken\n---\nP');

    const { items, problems } = await loadAgentDefinitions({ projectRoot: root, heawHome: home });

    expect(items.map((agent) => [agent.name, agent.description])).toEqual([
      ['helper', 'Personal.'],
      ['reviewer', 'Project reviewer.'],
    ]);
    expect(problems).toEqual([
      expect.stringContaining('broken.md: it has no description') as unknown,
    ]);
  });
});

describe('heaw init', () => {
  it('creates a reviewer agent that loads without problems', async () => {
    const root = await tempDir();
    await initCommand({ model: 'azure:x' }, { cwd: root, env: {}, stdout: { write: () => true } });

    const { items, problems } = await loadAgentDefinitions({
      projectRoot: root,
      heawHome: join(root, 'none'),
    });

    expect(problems).toEqual([]);
    expect(items).toMatchObject([
      {
        name: 'reviewer',
        mode: 'read-only',
        tools: ['read_file', 'list_dir', 'glob', 'grep'],
        limits: { maxTurns: 30 },
      },
    ]);
  });
});

describe('delegate', () => {
  it('runs a named agent with its tools and returns its report, counting its usage', async () => {
    const { model, engine } = await engineWith([
      {
        ...delegate({ agent: 'reviewer', task: 'Review app.ts' }),
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      {
        toolCalls: [{ name: 'read_file', args: { path: 'app.ts' } }],
        usage: { inputTokens: 50, outputTokens: 5 },
      },
      { text: 'app.ts:1 answer should be 42.', usage: { inputTokens: 60, outputTokens: 8 } },
      { text: 'The reviewer found one bug.', usage: { inputTokens: 200, outputTokens: 12 } },
    ]);

    const events = await collect(engine.session().send('Review my code'));
    await engine.dispose();

    const child = model.requests[1]!;
    // What all sub-agents share first, so their prompts start alike for the cache; its role last.
    expect(child.system).toMatch(/^You are a sub-agent\. /);
    expect(child.system).toMatch(
      /## Your role: reviewer\n\nYou review code\. Report bugs with file:line\.$/,
    );
    expect(child.cacheKey).toMatch(/:reviewer$/);
    expect(model.requests[0]?.cacheKey).toMatch(/:main$/);
    // It cannot run commands or ask the user for a go, so it is told neither to run checks nor
    // to plan, and does not report what it could not run.
    expect(child.system).toContain('You cannot run commands.');
    expect(child.system).not.toMatch(/running the project's tests|Plan before|start_plan/);
    expect(child.tools?.map((tool) => tool.name)).toEqual(['read_file', 'grep']);
    expect(textOf(child.messages[0]!)).toBe('Review app.ts');
    expect(lastToolOutput(model.requests[3])).toBe('app.ts:1 answer should be 42.');

    expect(ofType(events, 'subagent.start')).toMatchObject([
      { name: 'reviewer', childAgentId: 'reviewer-1' },
    ]);
    expect(ofType(events, 'subagent.end')).toMatchObject([
      { name: 'reviewer', stopReason: 'end_turn', turns: 2, usage: { inputTokens: 110 } },
    ]);
    const childTool = ofType(events, 'tool.start').find((event) => event.tool === 'read_file');
    expect(childTool).toMatchObject({ agentId: 'reviewer-1', parentAgentId: 'main' });
    // The parent's run counts every model call, its sub-agent's included.
    expect(events.at(-1)).toMatchObject({
      type: 'run.end',
      agentId: 'main',
      usage: { inputTokens: 410, outputTokens: 35 },
    });
  });

  it("thinks as hard as its definition says, and checks the sub-agents' model at the start", async () => {
    const { model, engine } = await engineWith(
      [
        delegate({ agent: 'thinker', task: 'Find the bug' }),
        { text: 'app.ts:1.' },
        { text: 'Found it.' },
      ],
      {
        reasoningEffort: 'low',
        agents: [{ ...reviewer, name: 'thinker', reasoningEffort: 'high', model: 'inherit' }],
      },
    );
    await collect(engine.session().send('Find the bug'));
    await engine.dispose();

    expect(model.requests.map((request) => request.reasoningEffort)).toEqual([
      'low',
      'high',
      'low',
    ]);
    // A wrong model for sub-agents shows when heaw starts, not in the middle of a task.
    await expect(engineWith([], { subagents: { model: 'nowhere:x' } })).rejects.toThrow(
      'Unknown provider "nowhere"',
    );
  });

  it('gives a general sub-agent the instructions and tools it is given, never delegate at depth 1', async () => {
    const { model, engine } = await engineWith([
      delegate({
        task: 'List files',
        instructions: 'You list files.',
        tools: ['list_dir', 'delegate', 'run_command'],
      }),
      { text: 'app.ts' },
      { text: 'done' },
    ]);

    await collect(engine.session().send('go'));
    await engine.dispose();

    expect(model.requests[1]?.system).toMatch(/## Your role: agent\n\nYou list files\.$/);
    // run_command is not one of the parent's tools, and depth 1 is the limit.
    expect(model.requests[1]?.tools?.map((tool) => tool.name)).toEqual(['list_dir']);
    expect(model.requests[0]?.tools?.map((tool) => tool.name)).toContain('delegate');
  });

  it('lets sub-agents nest when maxDepth allows', async () => {
    const { model, engine } = await engineWith(
      [
        delegate({ task: 'a' }),
        delegate({ task: 'b' }, 'd2'),
        { text: 'deep' },
        { text: 'mid' },
        { text: 'top' },
      ],
      { subagents: { maxDepth: 2 } },
    );

    const events = await collect(engine.session().send('go'));
    await engine.dispose();

    expect(model.requests[1]?.tools?.map((tool) => tool.name)).toContain('delegate');
    expect(model.requests[2]?.tools?.map((tool) => tool.name)).not.toContain('delegate');
    // Each start is reported by the agent that starts it.
    expect(
      ofType(events, 'subagent.start').map((event) => [event.childAgentId, event.agentId]),
    ).toEqual([
      ['agent-1', 'main'],
      ['agent-2', 'agent-1'],
    ]);
  });

  it("never loosens permissions: the caller's rules apply, and a mode can tighten them", async () => {
    const strict: AgentDefinition = {
      ...reviewer,
      name: 'strict',
      tools: ['write_file'],
      mode: 'read-only',
    };
    const { engine, workspace } = await engineWith(
      [
        delegate({ agent: 'strict', task: 'Write x' }),
        { toolCalls: [{ name: 'write_file', args: { path: 'x.txt', content: 'x' } }] },
        { text: 'could not write' },
        delegate({ task: 'Write y', tools: ['write_file'] }, 'd2'),
        { toolCalls: [{ name: 'write_file', args: { path: 'y.txt', content: 'y' } }] },
        { text: 'wrote y' },
        { text: 'done' },
      ],
      { agents: [strict], permissions: { mode: 'accept-edits' } },
    );

    const events = await collect(engine.session().send('go'));
    await engine.dispose();

    const writes = ofType(events, 'tool.end').filter((event) => event.tool === 'write_file');
    expect(writes.map((event) => event.status)).toEqual(['denied', 'ok']);
    expect(writes[0]?.output).toContain('read-only mode');
    expect((await workspace.readFile('y.txt')).toString()).toBe('y');
  });

  it('caps a sub-agent at what is left of the run budget', async () => {
    const { model, engine } = await engineWith(
      [
        { ...delegate({ task: 'big job' }), usage: { inputTokens: 900 } },
        {
          toolCalls: [{ name: 'list_dir', args: {} }],
          text: 'Started.',
          usage: { inputTokens: 500 },
        },
        { text: 'never' },
        { text: 'done', usage: { inputTokens: 10 } },
      ],
      { limits: { maxTokens: 1_000 }, subagents: { minBudget: { tokens: 50 } } },
    );

    const events = await collect(engine.session().send('go'));
    await engine.dispose();

    expect(ofType(events, 'subagent.end')[0]?.stopReason).toBe('token_limit');
    expect(ofType(events, 'tool.end').find((event) => event.tool === 'delegate')?.output).toBe(
      'Started.\n\n[The sub-agent reached its token limit, so its report may be incomplete.]',
    );
    expect(model.requests).toHaveLength(2);
    // The parent then stops too: its budget includes the sub-agent.
    expect(events.at(-1)).toMatchObject({ type: 'run.end', stopReason: 'token_limit' });
  });

  it("routes a sub-agent's approval requests to the session the user talks to", async () => {
    const { engine } = await engineWith(
      [
        delegate({ task: 'Write z', tools: ['write_file'] }),
        { toolCalls: [{ name: 'write_file', args: { path: 'z.txt', content: 'z' } }] },
        { text: 'wrote z' },
        { text: 'done' },
      ],
      { interactive: true },
    );
    const session = engine.session();
    const events: EngineEvent[] = [];

    for await (const event of session.send('go')) {
      events.push(event);
      if (event.type === 'approval.request')
        session.approve(event.requestId, { allow: true, scope: 'once' });
    }
    await engine.dispose();

    expect(ofType(events, 'approval.request')).toMatchObject([
      { tool: 'write_file', agentId: 'agent-1' },
    ]);
    expect(ofType(events, 'tool.end').find((event) => event.tool === 'write_file')?.status).toBe(
      'ok',
    );
  });

  it('lets an answer "for the session" through to requests waiting at the same time', async () => {
    // Two sub-agents ask about the same command at once. Before, the chat kept only the latest
    // request; the first was never answered and its sub-agent waited forever.
    const run = { toolCalls: [{ name: 'run_command', args: { command: 'git --version' } }] };
    const { engine } = await engineWith(
      [
        {
          toolCalls: [
            { name: 'delegate', args: { task: 'Check git', tools: ['run_command'] }, id: 'd1' },
            { name: 'delegate', args: { task: 'Check git', tools: ['run_command'] }, id: 'd2' },
          ],
        },
        run,
        run,
        { text: 'git is there' },
        { text: 'git is there' },
        { text: 'done' },
      ],
      { interactive: true, toolsets: ['fs', 'shell', 'agents'] },
    );
    const session = engine.session();
    const requests: string[] = [];
    const answered: string[] = [];
    const events: EngineEvent[] = [];

    for await (const event of session.send('go')) {
      events.push(event);
      if (event.type === 'approval.request') requests.push(event.requestId);
      // Answer only once both are waiting, the first one "for the session".
      if (event.type === 'approval.request' && requests.length === 2) {
        answered.push(requests[0]!);
        session.approve(requests[0]!, { allow: true, scope: 'session' });
      }
    }
    await engine.dispose();

    expect(answered).toHaveLength(1);
    expect(
      ofType(events, 'approval.response')
        .map((event) => event.requestId)
        .sort(),
    ).toEqual([...requests].sort());
    const runs = ofType(events, 'tool.end').filter((event) => event.tool === 'run_command');
    expect(runs.map((event) => event.status)).toEqual(['ok', 'ok']);
    expect(session.pendingApprovals).toEqual([]);
  });

  it('splits what the run has left among sub-agents started together, and starts none on too little', async () => {
    const { model, engine } = await engineWith(
      [
        {
          toolCalls: [
            { name: 'delegate', args: { task: 'a' }, id: 'd1' },
            { name: 'delegate', args: { task: 'b' }, id: 'd2' },
          ],
          usage: { inputTokens: 1_000 },
        },
        { text: 'done', usage: { inputTokens: 10 } },
      ],
      { limits: { maxTokens: 50_000 } },
    );

    const events = await collect(engine.session().send('go'));
    await engine.dispose();

    // 49,000 tokens left: 24,500 each, below the 30,000 a sub-agent needs.
    const outputs = ofType(events, 'tool.end').map((event) => event.output);
    expect(outputs).toHaveLength(2);
    for (const output of outputs) {
      expect(output).toMatch(
        /^Not started: this message has 49000 tokens of its limit left \(2 sub-agents started together share it\)/,
      );
    }
    expect(ofType(events, 'subagent.start')).toHaveLength(0);
    expect(model.requests).toHaveLength(2);
  });

  it('keeps a sub-agent to its files', async () => {
    const write = (path: string) => ({ name: 'write_file', args: { path, content: 'x' } });
    const { model, engine, workspace } = await engineWith(
      [
        delegate({ task: 'Build the page', tools: ['write_file'], files: ['src/deals/**'] }),
        { toolCalls: [write('src/deals/page.ts'), write('src/app.ts')] },
        { text: 'Wrote the page; src/app.ts was denied.' },
        { text: 'done' },
      ],
      { permissions: { mode: 'accept-edits' } },
    );

    const events = await collect(engine.session().send('go'));
    await engine.dispose();

    expect(textOf(model.requests[1]!.messages[0]!)).toContain(
      'Files you may change: src/deals/**. Changes to other files are denied.',
    );
    const writes = ofType(events, 'tool.end').filter((event) => event.tool === 'write_file');
    // A denied call ends when it is checked, before the allowed one runs.
    expect(writes.map((event) => event.status)).toEqual(['denied', 'ok']);
    expect(writes[0]?.output).toContain('src/app.ts is outside the files this agent was given');
    expect(await workspace.stat('src/app.ts')).toBeUndefined();
  });

  it('sends a sub-agent back once when it reports before its check passed', async () => {
    const check = { name: 'run_command', args: { command: 'git --version' } };
    const { model, engine } = await engineWith(
      [
        delegate({ task: 'Do it', tools: ['run_command'], check: 'git --version' }),
        { text: 'Done.' },
        { toolCalls: [check] },
        { text: 'Done, and the check passes.' },
        { text: 'ok' },
      ],
      {
        toolsets: ['fs', 'shell', 'agents'],
        permissions: { mode: 'accept-edits', allow: ['run_command(git --version)'] },
      },
    );

    const events = await collect(engine.session().send('go'));
    await engine.dispose();

    expect(textOf(model.requests[1]!.messages[0]!)).toContain(
      'Done when `git --version` passes: run it and make it pass before you report.',
    );
    expect(JSON.stringify(model.requests[2]?.messages.at(-1))).toContain(
      'Before you report: run `git --version` and make it pass.',
    );
    expect(ofType(events, 'tool.end').find((event) => event.tool === 'delegate')?.output).toBe(
      'Done, and the check passes.',
    );
    expect(ofType(events, 'subagent.end')[0]).toMatchObject({ turns: 3 });
  });

  it('says so when the check still did not pass', async () => {
    const { engine } = await engineWith(
      [
        delegate({ task: 'Do it', tools: ['run_command'], check: 'git --version' }),
        { text: 'Done.' },
        { text: 'Done, really.' },
        { text: 'ok' },
      ],
      { toolsets: ['fs', 'shell', 'agents'] },
    );

    const events = await collect(engine.session().send('go'));
    await engine.dispose();

    expect(ofType(events, 'tool.end').find((event) => event.tool === 'delegate')?.output).toBe(
      'Done, really.\n\n[The check `git --version` did not pass in the sub-agent; run it yourself.]',
    );
  });

  it('runs hooks: subagentStart can rewrite or block, subagentEnd can change the report, guards apply inside', async () => {
    const { model, engine } = await engineWith(
      [
        delegate({ agent: 'reviewer', task: 'review' }),
        { toolCalls: [{ name: 'read_file', args: { path: 'app.ts' } }] },
        { text: 'looks fine' },
        delegate({ task: 'forbidden work' }, 'd2'),
        { text: 'done' },
      ],
      {
        hooks: {
          subagentStart: ({ task }) =>
            task.startsWith('forbidden') ? { block: 'not today' } : { task: `${task} carefully` },
          subagentEnd: ({ result, agent }) => ({ result: `${agent} said: ${result}` }),
          beforeToolCall: ({ tool }) =>
            tool === 'read_file' ? { block: 'no reading' } : undefined,
          beforeStop: () => ({ continue: true, feedback: 'never for sub-agents' }),
        },
      },
    );

    const events = await collect(engine.session().send('go'));
    await engine.dispose();

    expect(textOf(model.requests[1]!.messages[0]!)).toBe('review carefully');
    expect(ofType(events, 'tool.end').find((event) => event.tool === 'read_file')?.output).toBe(
      'Blocked by a hook: no reading',
    );
    expect(lastToolOutput(model.requests[3])).toBe('reviewer said: looks fine');
    expect(
      ofType(events, 'tool.end')
        .filter((event) => event.tool === 'delegate')
        .at(-1)?.output,
    ).toBe('Blocked by a hook: not today');
  });

  it("saves a sub-agent's events once in the session log", async () => {
    const root = await tempDir();
    const store = new JsonlSessionStore(root);
    const { engine } = await engineWith(
      [delegate({ task: 'look' }), { text: 'seen' }, { text: 'done' }],
      {
        sessionStore: store,
      },
    );
    const session = engine.session();

    await collect(session.send('go'));
    await session.flush();
    await engine.dispose();

    const types = (await store.load(session.id)).flatMap((record) =>
      record.type === 'event' ? [record.event.type] : [],
    );
    expect(types.filter((type) => type === 'subagent.start')).toHaveLength(1);
    expect(types.filter((type) => type === 'subagent.end')).toHaveLength(1);
  });

  it('explains an unknown agent', async () => {
    const { model, engine } = await engineWith([
      delegate({ agent: 'nobody', task: 'x' }),
      { text: 'ok' },
    ]);

    await collect(engine.session().send('go'));
    await engine.dispose();

    expect(lastToolOutput(model.requests[1])).toBe(
      'There is no agent named "nobody". Named agents: reviewer. Omit agent for a general one.'.replace(
        'a general one',
        'a general sub-agent',
      ),
    );
  });

  it('runs delegate calls in parallel, up to maxParallel', async () => {
    const order = async (maxParallel: number) => {
      const scripts: Record<string, ScriptedModelClient> = {
        main: new ScriptedModelClient([
          {
            toolCalls: [
              { name: 'delegate', args: { task: 'A' }, id: 'a' },
              { name: 'delegate', args: { task: 'B' }, id: 'b' },
            ],
          },
          { text: 'both done' },
        ]),
        A: new ScriptedModelClient([{ text: 'report A', chunkSize: 1, chunkDelayMs: 5 }]),
        B: new ScriptedModelClient([{ text: 'report B', chunkSize: 1, chunkDelayMs: 5 }]),
      };
      const model = new RoutingModel((request) =>
        request.messages[0]?.role === 'user' && ['A', 'B'].includes(textOf(request.messages[0]))
          ? scripts[textOf(request.messages[0])]!
          : scripts.main!,
      );
      const engine = await createEngine({
        model,
        workspace: await tempWorkspace(),
        toolsets: ['agents'],
        interactive: false,
        git: false,
        subagents: { maxParallel },
      });
      const events = await collect(engine.session().send('go'));
      await engine.dispose();
      return events
        .filter((event) => event.type === 'subagent.start' || event.type === 'subagent.end')
        .map(
          (event) =>
            `${event.type === 'subagent.start' ? 'start' : 'end'} ${(event as { childAgentId: string }).childAgentId}`,
        );
    };

    expect((await order(4)).slice(0, 2)).toEqual(['start agent-1', 'start agent-2']);
    expect(await order(1)).toEqual([
      'start agent-1',
      'end agent-1',
      'start agent-2',
      'end agent-2',
    ]);
  });
});

describe('runAgent and callTool', () => {
  it('runs a named agent from code, with nobody asked', async () => {
    const { model, engine } = await engineWith([
      { toolCalls: [{ name: 'write_file', args: { path: 'w.txt', content: 'w' } }] },
      { text: 'Review: no bugs.', usage: { inputTokens: 5 } },
    ]);
    const events: string[] = [];

    const result = await engine.runAgent('reviewer', 'Review app.ts', {
      onEvent: (event) => events.push(event.type),
    });
    await engine.dispose();

    expect(result).toMatchObject({ text: 'Review: no bugs.', stopReason: 'end_turn', turns: 2 });
    expect(model.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['read_file', 'grep']);
    expect(model.requests[0]?.system).toContain('You review code. Report bugs with file:line.');
    expect(events[0]).toBe('run.start');
    await expect(engine.runAgent('ghost', 'x')).rejects.toThrow(
      'No agent named "ghost". Agents: main, reviewer.',
    );
  });

  it('calls a tool directly, with permissions and allow rules', async () => {
    const { engine, workspace } = await engineWith([]);

    expect(await engine.callTool('read_file', { path: 'app.ts' })).toMatchObject({
      status: 'ok',
      output: expect.stringContaining('answer = 41') as unknown,
    });
    expect((await engine.callTool('write_file', { path: 'n.txt', content: 'n' })).status).toBe(
      'denied',
    );
    expect(
      (
        await engine.callTool(
          'write_file',
          { path: 'n.txt', content: 'n' },
          { allow: ['write_file(n.txt)'] },
        )
      ).status,
    ).toBe('ok');
    await engine.dispose();
    expect((await workspace.readFile('n.txt')).toString()).toBe('n');
  });

  it("lets a run's allow rules cover what the config's ask rules ask about", async () => {
    const { engine, workspace } = await engineWith(
      [
        { toolCalls: [{ name: 'write_file', args: { path: 'out.txt', content: 'x' } }] },
        { text: 'Done.' },
      ],
      { permissions: { mode: 'accept-edits', ask: ['write_file(out.txt)'] } },
    );

    expect((await engine.callTool('write_file', { path: 'out.txt', content: 'x' })).status).toBe(
      'denied',
    );
    const result = await engine.runAgent('main', 'Write out.txt', {
      allow: ['write_file(out.txt)'],
    });
    await engine.dispose();

    expect(result.stopReason).toBe('end_turn');
    expect((await workspace.readFile('out.txt')).toString()).toBe('x');
  });
});

describe('skills', () => {
  async function skillsProject() {
    const root = await tempDir();
    const home = join(root, 'home');
    const skill = join(root, '.heaw', 'skills', 'release');
    await mkdir(join(skill, 'scripts'), { recursive: true });
    await mkdir(join(home, 'skills', 'release'), { recursive: true });
    await mkdir(join(home, 'skills', 'notes'), { recursive: true });
    await mkdir(join(home, 'skills', 'empty'), { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: release\ndescription: How to cut a release.\n---\n# Release\nRun the checks, then tag.',
    );
    await writeFile(join(skill, 'checklist.md'), '- [ ] changelog');
    await writeFile(join(skill, 'scripts', 'tag.sh'), 'git tag v$1');
    await writeFile(
      join(home, 'skills', 'release', 'SKILL.md'),
      '---\ndescription: Personal release.\n---\nOld',
    );
    await writeFile(
      join(home, 'skills', 'notes', 'SKILL.md'),
      '---\ndescription: Meeting notes.\n---\nN',
    );
    await writeFile(join(home, 'skills', 'empty', 'SKILL.md'), 'no front matter');
    return { root, home };
  }

  it('loads personal and project skills, the project winning, and reports unusable ones', async () => {
    const { root, home } = await skillsProject();

    const { items, problems } = await loadSkills({ projectRoot: root, heawHome: home });

    expect(items.map((skill) => [skill.name, skill.description, skill.shownDir])).toEqual([
      // Inside the project (as in this test), a skill's folder is shown relative to it.
      ['notes', 'Meeting notes.', 'home/skills/notes'],
      ['release', 'How to cut a release.', '.heaw/skills/release'],
    ]);
    expect(problems).toEqual([expect.stringContaining('it has no description') as unknown]);
  });

  it('lists skills in the system prompt and loads them, and their files, on demand', async () => {
    const { root, home } = await skillsProject();
    const { items } = await loadSkills({ projectRoot: root, heawHome: home });
    const model = new ScriptedModelClient([
      {
        toolCalls: [
          { name: 'load_skill', args: { name: 'release' }, id: 's1' },
          { name: 'load_skill', args: { name: 'release', file: 'scripts/tag.sh' }, id: 's2' },
          { name: 'load_skill', args: { name: 'release', file: '../notes/SKILL.md' }, id: 's3' },
        ],
      },
      { text: 'ok' },
    ]);
    const engine = await createEngine({
      model,
      workspace: await tempWorkspace(),
      toolsets: ['skills'],
      skills: items,
      git: false,
    });

    await collect(engine.session().send('Cut a release'));
    await engine.dispose();

    expect(model.requests[0]?.system).toContain(
      "Skills: this project's own instructions for particular kinds of tasks",
    );
    expect(model.requests[0]?.system).toContain('- release: How to cut a release.');
    const results = model.requests[1]!.messages.at(-1)!;
    const outputs = results.role === 'tool' ? results.content.map((part) => part.output) : [];
    expect(outputs[0]).toBe(
      '# Skill: release\n\n# Release\nRun the checks, then tag.\n\nFiles in this skill, in .heaw/skills/release (read one with load_skill and file):\n- checklist.md\n- scripts/tag.sh',
    );
    expect(outputs[1]).toBe('git tag v$1');
    expect(outputs[2]).toBe('"../notes/SKILL.md" is not a file of the skill release.');
  });
});

describe('restricted permissions', () => {
  it('can only be stricter than the policy it comes from, and follows it', () => {
    const base = new PermissionPolicy({ mode: 'accept-edits', allow: ['run_command(npm test)'] });
    const view = base.restricted({ mode: 'read-only', deny: ['read_file(secret*)'] });
    const check = (name: string, kind: 'read' | 'write' | 'execute', subject?: string) =>
      view.check(
        { name, kind },
        subject === undefined ? undefined : { value: subject, type: 'text' },
      ).decision;

    expect(check('write_file', 'write')).toBe('deny');
    expect(check('run_command', 'execute', 'npm test')).toBe('deny');
    expect(check('read_file', 'read', 'secret.txt')).toBe('deny');
    expect(check('read_file', 'read', 'app.ts')).toBe('allow');
    expect(view.mode).toBe('read-only');

    const loose = base.restricted({});
    base.setMode('read-only');
    expect(loose.check({ name: 'write_file', kind: 'write' }, undefined).decision).toBe('deny');
    expect(loose.mode).toBe('read-only');
  });
});

/** Answers each request with the scripted model `pick` chooses, e.g. one per sub-agent. */
class RoutingModel implements ModelClient {
  readonly id = 'scripted:test';
  readonly capabilities = new ScriptedModelClient([]).capabilities;

  constructor(private readonly pick: (request: ModelRequest) => ScriptedModelClient) {}

  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    return this.pick(request).stream(request, signal);
  }
}
