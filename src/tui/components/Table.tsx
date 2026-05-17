import { Box, Text } from 'ink';
import React from 'react';

import { allocateContentColumns, pad } from 'src/tui/utils/format.js';
import { WindowFooter } from 'src/tui/components/WindowFooter.js';

export type Column<T> = {
  label: string;
  value: (r: T) => string;
  min: number;
  max?: number;
  /** Lower number = considered first ("most important"). Default 0. */
  priority?: number;
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
  w,
}: {
  columns: Column<T>[];
  row: T;
  selected: boolean;
  w: number[];
}) {
  return (
    <Text inverse={selected}>
      {' '}
      {columns.map((c, i) => pad(c.value(row), w[i]!)).join('  ')}{' '}
    </Text>
  );
}
