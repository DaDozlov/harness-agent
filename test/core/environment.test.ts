import { describe, expect, it } from 'vitest';
import { formatEnvironment } from '../../src/core/environment.js';
import { createEngine, DEFAULT_SYSTEM_PROMPT } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';

describe('formatEnvironment', () => {
  it('gives the date and weekday in the local time zone', () => {
    // 23:30 UTC on Wednesday is already Thursday in Berlin.
    const block = formatEnvironment({
      now: new Date('2026-10-28T23:30:00Z'),
      timeZone: 'Europe/Berlin',
      platform: 'win32',
      cwd: 'C:\\Projects\\app',
    });

    expect(block).toBe(
      [
        '<environment>',
        'Today: Thursday, 2026-10-29 (time zone Europe/Berlin)',
        'Operating system: Windows',
        'Working directory: C:\\Projects\\app',
        '</environment>',
      ].join('\n'),
    );
  });
});

describe('createEngine', () => {
  it('adds the environment block after the base prompt (no tools)', async () => {
    const model = new ScriptedModelClient([{ text: 'ok' }]);
    const session = (await createEngine({ model, toolsets: [] })).session();

    for await (const event of session.send('Hi')) void event;

    const system = model.requests[0]?.system ?? '';
    expect(system.startsWith(`${DEFAULT_SYSTEM_PROMPT}\n\n<environment>\nToday: `)).toBe(true);
    expect(system).toContain(`Working directory: ${process.cwd()}`);
  });
});
