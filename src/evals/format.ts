/** Columns padded to their widest cell, two spaces apart. */
export function formatTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

/** An average of whole numbers: 7 → 7, 7.333 → 7.3. */
export function average(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 1234 → 1.2k. */
export function shortCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(Math.round(count));
}

/** `2026-11-02 14:15` in local time. */
export function localTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
