import { Box, Text } from 'ink';
import React, { type ReactNode } from 'react';

import { allocateContentColumns, pad } from 'src/tui/utils/format.js';
import { WindowFooter } from 'src/tui/components/WindowFooter.js';

export type Column<T> = {
  label: string;
  /** Plain-text projection of the cell. Always used for width budgeting; also
   * used to draw the cell when `render` is not provided. */
  value: (r: T) => string;
  min: number;
  max?: number;
  /** Lower number = considered first ("most important"). Default 0. */
  priority?: number;
  /** Cell text alignment within the column. Defaults to left; use 'right' for
   * numeric columns so the digits line up under the right edge of the header. */
  align?: 'left' | 'right';
  /** Ink text color applied to both the header label and the (non-`render`)
   * cell text, so a column can carry meaning through color alone. */
  color?: string;
  /** Optional rich renderer. When set, the cell draws `render(r)` instead of
   * the padded `value(r)` string — used for per-character coloring (e.g.
   * the tags column's colored dots). The renderer is responsible for
   * padding/trimming itself to `width` so columns stay aligned; the helper
   * `padNode(node, plain, width)` covers the common case. */
  render?: (r: T, width: number) => ReactNode;
};

export type TableProps<T> = {
  rows: T[];
  columns: Column<T>[];
  cursor: number;
  windowStart: number;
  visibleCount: number;
  width: number;
  /** Stable identifier for React keys + Ink reconciliation. */
  getKey: (r: T) => string;
  /** Shown when `rows` is empty. */
  emptyMessage: string;
  /** When false, suppress the row-selection highlight. */
  active?: boolean;
  /** Per-row dim predicate. Rows where this returns true render in dim color
   * (still inversed when selected, so the cursor stays legible). Used by the
   * Sources tab to mark out-of-scope-for-identify-job-list-url rows. */
  isDim?: (r: T) => boolean;
  /** String drawn between adjacent columns in both the header and the rows.
   * Defaults to a 2-char gap; pass ' │ ' to draw vertical cell dividers. */
  separator?: string;
};

/**
 * Generic content-fit table:
 *   - Column widths are allocated from full data set so they don't shift as
 *     the cursor scrolls.
 *   - 2-char gap between columns, plus 1 char of padding on each side of the
 *     row so the selection highlight (inverse) extends past the columns.
 *   - Header and rows share the same padding scheme so columns line up.
 *   - Slices the row array internally based on `windowStart`/`visibleCount`.
 */
export function Table<T>({
  rows,
  columns,
  cursor,
  windowStart,
  visibleCount,
  width,
  getKey,
  emptyMessage,
  active = true,
  isDim,
  separator = '  ',
}: TableProps<T>) {
  if (rows.length === 0) return <Text dimColor>{emptyMessage}</Text>;

  // Reserve (N-1)*separator cols for inter-column gaps and 2 cols for the row's
  // selection-highlight padding.
  const colSpace = Math.max(
    0,
    width - (columns.length - 1) * separator.length - 2
  );

  const w = allocateContentColumns(
    colSpace,
    columns.map(c => ({
      contentMax: Math.max(c.label.length, ...rows.map(r => c.value(r).length)),
      min: c.min,
      max: c.max,
      priority: c.priority,
    }))
  );

  const visible = rows.slice(windowStart, windowStart + visibleCount);
  const localCursor = cursor - windowStart;

  return (
    <Box flexDirection='column'>
      <Text bold>
        {' '}
        {columns.map((c, i) => {
          const label = pad(c.label, w[i]!, c.align);
          return (
            <React.Fragment key={`${c.label}#${i}`}>
              {i > 0 && separator}
              {c.color ? <Text color={c.color}>{label}</Text> : label}
            </React.Fragment>
          );
        })}{' '}
      </Text>
      {visible.map((r, i) => (
        <Row
          key={getKey(r)}
          columns={columns}
          row={r}
          selected={active && i === localCursor}
          dim={isDim?.(r) ?? false}
          w={w}
          separator={separator}
        />
      ))}
      <WindowFooter
        windowStart={windowStart}
        windowEnd={windowStart + visible.length}
        total={rows.length}
        visibleCount={visibleCount}
      />
    </Box>
  );
}

function Row<T>({
  columns,
  row,
  selected,
  dim,
  w,
  separator,
}: {
  columns: Column<T>[];
  row: T;
  selected: boolean;
  dim: boolean;
  w: number[];
  separator: string;
}) {
  // Columns that carry a rich renderer or a per-column color can't be flattened
  // into a single padded string, so any of them forces the per-cell path.
  const isRich = columns.some(c => c.render || c.color);
  if (!isRich) {
    return (
      <Text inverse={selected} dimColor={dim}>
        {' '}
        {columns
          .map((c, i) => pad(c.value(row), w[i]!, c.align))
          .join(separator)}{' '}
      </Text>
    );
  }

  // Rich path: interleave columns as <Text> children + literal separator gaps
  // so per-character colors (e.g. tag dots) and per-column colors survive ink's
  // render. Outer Text owns the inverse/dim styling so selection still
  // highlights the full row.
  return (
    <Text inverse={selected} dimColor={dim}>
      {' '}
      {columns.map((c, i) => {
        const cell = c.render
          ? c.render(row, w[i]!)
          : pad(c.value(row), w[i]!, c.align);

        return (
          <React.Fragment key={`${c.label}#${i}`}>
            {i > 0 && separator}
            {c.color && !c.render ? <Text color={c.color}>{cell}</Text> : cell}
          </React.Fragment>
        );
      })}{' '}
    </Text>
  );
}
