const UNITS = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
];

/**
 * Milliseconds as text such as "1d 2h 30m": days, hours, minutes and seconds, largest first,
 * leaving out the units that are zero. Less than a second is "0s".
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Not a duration: ${ms}`);
  let rest = Math.floor(ms / 1000) * 1000;
  const parts = [];
  for (const [unit, size] of UNITS) {
    const count = Math.floor(rest / size);
    if (count > 0) parts.push(`${count}${unit}`);
    rest -= count * size;
  }
  return parts.join(' ') || '0s';
}

/** Text such as "1d 2h 30m" as milliseconds: the reverse of formatDuration(). */
export function parseDuration(text) {
  const fail = () => new RangeError(`Not a duration: ${JSON.stringify(text)}`);
  if (typeof text !== 'string' || text === '') throw fail();
  let ms = 0;
  let next = 0;
  for (const part of text.split(' ')) {
    const match = /^(\d+)([dhms])$/.exec(part);
    if (!match) throw fail();
    const index = UNITS.findIndex(([unit]) => unit === match[2]);
    // Largest first, each unit at most once.
    if (index < next) throw fail();
    next = index + 1;
    ms += Number(match[1]) * UNITS[index][1];
  }
  return ms;
}
