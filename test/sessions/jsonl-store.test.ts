import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSessionId,
  restoreSession,
  type SessionRecord,
  type SessionStore,
  SessionNotFoundError,
} from '../../src/core/session-store.js';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { JsonlSessionStore } from '../../src/sessions/jsonl-store.js';
import { collect } from '../helpers.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempStore() {
  const root = await mkdtemp(join(tmpdir(), 'heaw-sessions-'));
  roots.push(root);
  return new JsonlSessionStore(root);
}

const header = (id: string): SessionRecord => ({
  type: 'session',
  version: 1,
  id,
  createdAt: '2026-10-30T10:00:00.000Z',
  cwd: '/project',
  model: 'scripted:test',
});
const user = (text: string): SessionRecord => ({
  type: 'message',
  timestamp: 1,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

describe('createSessionId', () => {
  it('is readable, sortable by time and unique', () => {
    const id = createSessionId(new Date(2026, 9, 30, 14, 5, 9));
    expect(id).toMatch(/^20261030-140509-[0-9a-z]{4}$/);
    expect(new Set(Array.from({ length: 50 }, () => createSessionId())).size).toBe(50);
  });
});

describe('JsonlSessionStore', () => {
  it('appends records and loads them back, keeping the folder out of git', async () => {
    const store = await tempStore();

    await store.append('s1', [header('s1'), user('Hi')]);
    await store.append('s1', [user('Again')]);

    expect(await store.load('s1')).toEqual([header('s1'), user('Hi'), user('Again')]);
    expect(await readFile(join(store.dir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('skips a half-written last line', async () => {
    const store = await tempStore();
    await store.append('s1', [header('s1'), user('Hi')]);
    await appendFile(join(store.dir, 's1.jsonl'), '{"type":"message","timest');

    expect(await store.load('s1')).toHaveLength(2);
  });

  it('lists sessions, most recently updated first, titled by the first message', async () => {
    const store = await tempStore();
    await store.append('older', [header('older'), user('Fix the login bug')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.append('newer', [header('newer'), user(`Write ${'many '.repeat(30)}docs`)]);

    const sessions = await store.list();

    expect(sessions.map((s) => s.id)).toEqual(['newer', 'older']);
    expect(sessions[1]).toMatchObject({
      title: 'Fix the login bug',
      messages: 1,
      model: 'scripted:test',
    });
    expect(sessions[0]?.title).toHaveLength(80);
  });

  it('leaves sessions a hook ran out of the list, and still loads them by id', async () => {
    const store = await tempStore();
    await store.append('chat', [header('chat'), user('Add the email')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The tester the chat's check ran, saved last.
    await store.append('tester', [
      { ...header('tester'), startedBy: 'chat' } as SessionRecord,
      user('Changed: public/format.js. Use the pages they affect.'),
    ]);

    expect((await store.list()).map((s) => s.id)).toEqual(['chat']);
    expect((await store.list(1)).map((s) => s.id)).toEqual(['chat']);
    expect(await store.resolve('tester')).toBe('tester');
    expect(await store.load('tester')).toHaveLength(2);
  });

  it('resolves ids and unique prefixes, and rejects unknown, ambiguous and unsafe ones', async () => {
    const store = await tempStore();
    await store.append('20261030-100000-aaaa', [header('a')]);
    await store.append('20261030-100000-abbb', [header('b')]);

    expect(await store.resolve('20261030-100000-aaaa')).toBe('20261030-100000-aaaa');
    expect(await store.resolve('20261030-100000-ab')).toBe('20261030-100000-abbb');
    await expect(store.resolve('20261030-100000-a')).rejects.toThrow('matches 2 sessions');
    await expect(store.resolve('nope')).rejects.toThrow(SessionNotFoundError);
    await expect(store.resolve('../../etc/passwd')).rejects.toThrow('is not a session id');
    await expect(store.load('missing')).rejects.toThrow(SessionNotFoundError);
  });

  it('lists nothing before any session was saved', async () => {
    expect(await (await tempStore()).list()).toEqual([]);
  });
});

describe('restoreSession', () => {
  it('answers tool calls left open by a session that ended abruptly', () => {
    const { messages } = restoreSession([
      header('s'),
      user('Run it'),
      {
        type: 'message',
        timestamp: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'run_command', args: {} }],
        },
      },
    ]);

    expect(messages.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          callId: 'c1',
          name: 'run_command',
          output: 'Not run: the session ended before this call finished.',
          isError: true,
        },
      ],
    });
  });
});

describe('saving and resuming through the engine', () => {
  it('saves a conversation and continues it in a new engine', async () => {
    const store = await tempStore();
    const first = await createEngine({
      model: new ScriptedModelClient([
        { text: 'Paris.', usage: { inputTokens: 10, outputTokens: 2 } },
      ]),
      toolsets: [],
      sessionStore: store,
    });
    const session = first.session();
    await collect(session.send('Capital of France?'));

    const model = new ScriptedModelClient([{ text: 'About 2 million.' }]);
    const second = await createEngine({ model, toolsets: [], sessionStore: store });
    const resumed = await second.resume(session.id.slice(0, 18));
    await collect(resumed.send('Population?'));

    expect(resumed.id).toBe(session.id);
    expect(model.requests[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(resumed.usage.inputTokens).toBe(10);

    const records = await store.load(session.id);
    expect(records.filter((r) => r.type === 'session')).toHaveLength(1);
    expect(records.filter((r) => r.type === 'message')).toHaveLength(4);
    expect(records.some((r) => r.type === 'event' && r.event.type === 'text.delta')).toBe(false);
    expect((await second.sessions())[0]).toMatchObject({
      id: session.id,
      title: 'Capital of France?',
    });
  });

  it('does not save a session that never received a message', async () => {
    const store = await tempStore();
    const engine = await createEngine({
      model: new ScriptedModelClient([]),
      toolsets: [],
      sessionStore: store,
    });

    engine.session();

    expect(await store.list()).toEqual([]);
  });

  it('reports a failed save once, as a recoverable error, without failing the run', async () => {
    const failing: SessionStore = {
      append: () => Promise.reject(new Error('disk full')),
      load: () => Promise.resolve([]),
      list: () => Promise.resolve([]),
      resolve: (id) => Promise.resolve(id),
    };
    const engine = await createEngine({
      model: new ScriptedModelClient([{ text: 'ok' }]),
      toolsets: [],
      sessionStore: failing,
    });

    const events = await collect(engine.session().send('Hi'));

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toEqual([
      expect.objectContaining({
        recoverable: true,
        error: { name: 'SessionSaveError', message: 'Could not save the session: disk full' },
      }),
    ]);
    expect(events.find((e) => e.type === 'run.end')).toMatchObject({ stopReason: 'end_turn' });
  });

  it('refuses to resume without a store', async () => {
    const engine = await createEngine({ model: new ScriptedModelClient([]), toolsets: [] });
    await expect(engine.resume('x')).rejects.toThrow('needs a session store');
  });
});
