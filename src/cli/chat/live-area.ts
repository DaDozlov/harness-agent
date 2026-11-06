import type { TranscriptItem } from './transcript.js';

/**
 * Ink redraws the live area (everything below the printed transcript) on every update, and
 * cannot erase lines that scrolled off screen: a live area taller than the terminal prints a new
 * copy of its top on every redraw. Four parallel sub-agents with an approval prompt were enough
 * for that, so the live area is fitted to the rows there are.
 */
export interface LiveLayout {
  /** The live items to draw, labels shortened to one screen line. */
  items: TranscriptItem[];
  /** Running calls left out, shown as one line. */
  hidden: number;
  /** Delegate calls drawn without their progress line. */
  compact: boolean;
  /** Lines the approval prompt may use for its preview. */
  previewLines: number;
}

/** The approval prompt without its preview: border, question, reason, four options, margins. */
export const APPROVAL_FRAME_ROWS = 11;
/** The approval preview's own limit (see preview.ts). */
const MAX_PREVIEW_LINES = 12;

export function fitLiveArea(
  live: TranscriptItem[],
  space: { rows: number; columns: number },
  approval?: { previewLines: number; waiting: number },
): LiveLayout {
  const items = live.map((item) => oneLine(item, space.columns));
  const promptRows = approval ? APPROVAL_FRAME_ROWS + (approval.waiting > 0 ? 1 : 0) : 0;
  const wantedPreview = approval ? Math.min(approval.previewLines, MAX_PREVIEW_LINES) : 0;
  const fits = (shown: TranscriptItem[], compact: boolean, hidden: number) =>
    heightOf(shown, compact) + (hidden ? 1 : 0) + promptRows;

  // 1. Everything, with the approval preview shortened if needed.
  let layout: LiveLayout = { items, hidden: 0, compact: false, previewLines: wantedPreview };
  const room = (shown: TranscriptItem[], compact: boolean, hidden: number) =>
    space.rows - fits(shown, compact, hidden);
  if (room(items, false, 0) >= Math.min(wantedPreview, 3)) {
    return { ...layout, previewLines: Math.min(wantedPreview, room(items, false, 0)) };
  }
  // 2. Delegate calls without their progress lines.
  layout = { ...layout, compact: true };
  if (room(items, true, 0) >= Math.min(wantedPreview, 3)) {
    return { ...layout, previewLines: Math.min(wantedPreview, room(items, true, 0)) };
  }
  // 3. Sub-agents' running calls summed up; their delegate lines and approvals stay.
  const kept = items.filter((item) => !isSubagentCall(item));
  let hidden = items.length - kept.length;
  // 4. Then the oldest running items, keeping the newest and anything waiting for approval.
  const need = approval ? 1 : 0;
  while (room(kept, true, hidden) < need && kept.some(isDroppable)) {
    kept.splice(kept.findIndex(isDroppable), 1);
    hidden++;
  }
  const left = room(kept, true, hidden);
  return {
    items: kept,
    hidden,
    compact: true,
    previewLines: Math.max(1, Math.min(wantedPreview, left)),
  };
}

function isSubagentCall(item: TranscriptItem): boolean {
  return item.kind === 'tool' && item.agent !== undefined && item.status === 'running';
}

function isDroppable(item: TranscriptItem): boolean {
  return item.kind === 'tool' && item.status === 'running';
}

/** Rows an item takes in the live area (labels are one line, see `oneLine`). */
function heightOf(items: TranscriptItem[], compact: boolean): number {
  let rows = 0;
  let previous: TranscriptItem | undefined;
  for (const item of items) {
    if (item.kind === 'tool') {
      const spaced = !item.agent && previous?.kind !== 'tool' && previous?.kind !== 'agent';
      rows += 1 + (spaced ? 1 : 0);
      if (item.status === 'approval') rows += 1;
      if (item.status === 'running' && item.progress && !compact) rows += 1;
    } else if (item.kind === 'agent') {
      rows += previous?.kind === 'agent' ? 1 : 2;
    } else if (item.kind !== 'assistant') {
      rows += 2;
    }
    // Streaming text fits itself to the space it is given (ItemView).
    previous = item;
  }
  return rows;
}

/** A running tool's label cut to one screen line, so its height is known. */
function oneLine(item: TranscriptItem, columns: number): TranscriptItem {
  if (item.kind !== 'tool') return item;
  const prefix = 4 + (item.agent ? item.agent.length + 3 : 0);
  const room = Math.max(10, columns - prefix);
  return item.label.length > room ? { ...item, label: `${item.label.slice(0, room - 1)}…` } : item;
}
