/** Render `rows` as a CSV string with `cols` as the header.
 *
 * - Header row is `cols.join(',')`.
 * - Each cell is stringified via `String(value)` (with `null`/`undefined`
 *   becoming empty), then escaped: wrapped in double quotes when the
 *   value contains `,`, `"`, `\r`, or `\n`, with embedded `"` doubled.
 * - Empty `rows` returns just the header + newline. */
export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  cols: readonly (keyof T)[]
): string {
  const header = cols.map(c => escapeCsv(String(c))).join(',');
  const body = rows
    .map(r => cols.map(c => escapeCsv(r[c])).join(','))
    .join('\n');

  return rows.length === 0 ? `${header}\n` : `${header}\n${body}\n`;
}

export function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (
    s.includes(',') ||
    s.includes('"') ||
    s.includes('\n') ||
    s.includes('\r')
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}
