function parseDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new RangeError(`Not a date: ${text}`);
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`No such date: ${text}`);
  }
  return date;
}

/** Working days (Monday to Friday) after `from`, up to and including `to`; negative backwards. */
export function businessDaysBetween(from, to) {
  const start = parseDay(from);
  const end = parseDay(to);
  const step = end >= start ? 1 : -1;
  let count = 0;
  for (const day = new Date(start); day.getTime() !== end.getTime();) {
    day.setUTCDate(day.getUTCDate() + step);
    const weekday = (step === 1 ? day : new Date(day.getTime() + 86_400_000)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += step;
  }
  return count;
}
