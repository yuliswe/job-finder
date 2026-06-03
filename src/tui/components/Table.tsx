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
   * Sources tab to mark out-of-scope-for-listing rows. */
  isDim?: (r: T) => boolean;
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
}: TableProps<T>) {
  if (rows.length === 0) return <Text dimColor>{emptyMessage}</Text>;

  // Reserve (N-1)*2 cols for inter-column gaps and 2 cols for the row's
  // selection-highlight padding.
  const colSpace = Math.max(0, width - (columns.length - 1) * 2 - 2);
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
        {columns.map((c, i) => pad(c.label, w[i]!)).join('  ')}{' '}
      </Text>
      {visible.map((r, i) => (
        <Row
          key={getKey(r)}
          columns={columns}
          row={r}
          selected={active && i === localCursor}
          dim={isDim?.(r) ?? false}
          w={w}
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
}: {
  columns: Column<T>[];
  row: T;
  selected: boolean;
  dim: boolean;
  w: number[];
}) {
  const hasRender = columns.some(c => c.render);
  if (!hasRender) {
    return (
      <Text inverse={selected} dimColor={dim}>
        {' '}
        {columns.map((c, i) => pad(c.value(row), w[i]!)).join('  ')}{' '}
      </Text>
    );
  }

  // Rich path: interleave columns as <Text> children + literal "  " gaps so
  // per-character colors (e.g. tag dots) survive ink's render. Outer Text
  // owns the inverse/dim styling so selection still highlights the full row.
  return (
    <Text inverse={selected} dimColor={dim}>
      {' '}
      {columns.map((c, i) => (
        <React.Fragment key={c.label}>
          {i > 0 && '  '}
          {c.render ? c.render(row, w[i]!) : pad(c.value(row), w[i]!)}
        </React.Fragment>
      ))}{' '}
    </Text>
  );
}
