import { describe, expect, it } from 'vitest';
import { APPROVAL_FRAME_ROWS, fitLiveArea } from '../../src/cli/chat/live-area.js';
import type { TranscriptItem } from '../../src/cli/chat/transcript.js';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

const delegate = (n: number): ToolItem => ({
  kind: 'tool',
  id: `d${n}`,
  callId: `main:d${n}`,
  tool: 'delegate',
  label: `delegate ui-builder: Step 8, part ${n}. Goal: build this part of the frontend in its own folder and nothing else`,
  status: 'running',
  progress: { agent: `ui-builder ${n}`, color: 'cyan', calls: 12, last: 'read_file a.ts' },
});
const call = (n: number, status: ToolItem['status'] = 'running'): ToolItem => ({
  kind: 'tool',
  id: `c${n}`,
  callId: `ui-builder-${n}:c${n}`,
  tool: 'read_file',
  label: `read_file web/src/features/part-${n}/Page.tsx`,
  status,
  agent: `ui-builder ${n % 4}`,
});

/** Rows the fitted live area takes, the way ItemView draws it. */
function rowsOf(items: TranscriptItem[], compact: boolean, hidden: number, prompt: number): number {
  let rows = hidden ? 1 : 0;
  items.forEach((item, index) => {
    if (item.kind !== 'tool') return;
    const previous = items[index - 1];
    rows += 1 + (!item.agent && previous?.kind !== 'tool' ? 1 : 0);
    if (item.status === 'approval') rows += 1;
    if (item.status === 'running' && item.progress && !compact) rows += 1;
  });
  return rows + prompt;
}

describe('the live area', () => {
  const space = { rows: 20, columns: 100 };

  it('is left alone when it fits', () => {
    const live = [delegate(1), call(1)];

    const layout = fitLiveArea(live, space);

    expect(layout).toMatchObject({ hidden: 0, compact: false });
    expect(layout.items).toHaveLength(2);
  });

  it('fits four sub-agents, their calls and an approval prompt into a short terminal', () => {
    // The case that printed copies: 22-26 rows in a terminal of about 22.
    const live = [
      delegate(1),
      delegate(2),
      delegate(3),
      delegate(4),
      call(5, 'approval'),
      call(6),
      call(7),
      call(8),
    ];

    const short = { rows: 22, columns: 100 };
    const layout = fitLiveArea(live, short, { previewLines: 10, waiting: 1 });

    const prompt = APPROVAL_FRAME_ROWS + 1 + layout.previewLines;
    expect(rowsOf(layout.items, layout.compact, layout.hidden, prompt)).toBeLessThanOrEqual(
      short.rows,
    );
    // Progress lines go first, then the sub-agents' running calls; approvals always stay.
    expect(layout.compact).toBe(true);
    expect(layout.hidden).toBe(3);
    expect(layout.items.map((item) => item.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'c5']);
    expect(layout.previewLines).toBeGreaterThanOrEqual(1);
  });

  it('cuts labels to one line, so their height is known', () => {
    const layout = fitLiveArea([delegate(1)], { rows: 20, columns: 40 });

    const [item] = layout.items as ToolItem[];
    expect(item?.label).toHaveLength(36);
    expect(item?.label.endsWith('…')).toBe(true);
  });

  it('leaves out the oldest running lines when even that does not fit', () => {
    const live = Array.from({ length: 12 }, (_, index) => ({
      ...delegate(index + 1),
      progress: undefined,
    }));

    const layout = fitLiveArea(live, { rows: 8, columns: 100 });

    expect(rowsOf(layout.items, layout.compact, layout.hidden, 0)).toBeLessThanOrEqual(8);
    expect(layout.items.at(-1)?.id).toBe('d12');
    expect(layout.hidden).toBe(12 - layout.items.length);
  });
});
