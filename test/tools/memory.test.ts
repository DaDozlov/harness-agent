import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine.js';
import { ScriptedModelClient } from '../../src/providers/scripted.js';
import { formatMemory, MEMORY_FILE } from '../../src/tools/memory.js';
import { tempWorkspaceFactory } from '../helpers.js';

const tempWorkspace = tempWorkspaceFactory();
const remember = (note: string) => ({ toolCalls: [{ name: 'remember', args: { note } }] });

describe('memory', () => {
  it('shows saved notes to later sessions, and asks before saving one', async () => {
    const workspace = await tempWorkspace();
    await workspace.writeFile(MEMORY_FILE, '# Memory\n\n- 2026-10-01: Tests need Docker running.');
    const model = new ScriptedModelClient([
      remember('Run npm run db:up before the tests.'),
      { text: 'Could not save it.' },
      remember('Run npm run db:up before the tests.'),
      { text: 'Saved.' },
      { text: 'Hi.' },
    ]);
    const engine = await createEngine({
      model,
      workspace,
      toolsets: ['fs', 'memory'],
      permissions: { mode: 'bypass' },
      git: false,
    });

    const denied = await engine.runAgent('main', 'Remember how to run the tests');
    await engine.runAgent('main', 'Remember how to run the tests', { allow: ['remember'] });
    await engine.runAgent('main', 'Hello');
    await engine.dispose();

    expect(denied.stopReason).toBe('end_turn');
    expect(JSON.stringify(model.requests[1]?.messages.at(-1))).toContain(
      'which controls heaw itself, so it is always asked about',
    );
    expect(model.requests[0]?.system).toContain('## Memory (.heaw/memory.md)');
    expect(model.requests[0]?.system).toContain('Tests need Docker running.');
    expect(model.requests[4]?.system).toMatch(
      /- \d{4}-\d\d-\d\d: Run npm run db:up before the tests\./,
    );
    const saved = (await workspace.readFile(MEMORY_FILE)).toString();
    expect(saved.match(/db:up/g)).toHaveLength(1);
    expect(saved.startsWith('# Memory')).toBe(true);
  });

  it('keeps the newest notes when the memory outgrows the prompt', () => {
    const long = `# Memory\n${'- old note\n'.repeat(2_000)}- newest note`;
    const section = formatMemory(long)!;

    expect(section).toContain('[older notes left out]');
    expect(section.endsWith('- newest note')).toBe(true);
    expect(section.length).toBeLessThan(13_000);
    expect(formatMemory(undefined)).toBeUndefined();
  });
});
