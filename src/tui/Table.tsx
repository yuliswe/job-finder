import { Box, Text } from 'ink';
import React from 'react';

type Cell = string | number | boolean | null | undefined;
type Row = Record<string, Cell>;

export type TableProps<T extends Row> = {
  data: readonly T[];
  columns: readonly (keyof T)[];
  padding?: number;
};

export function Table<T extends Row>({
  data,
  columns,
  padding = 1,
}: TableProps<T>) {
  const widths = columns.map(c => {
    const headerLen = String(c).length;
    const cellMax = data.reduce(
      (m, row) => Math.max(m, format(row[c]).length),
      0
    );
    return Math.max(headerLen, cellMax);
  });

  return (
    <Box flexDirection='column'>
      <Divider widths={widths} padding={padding} char='─' />
      <Row
        cells={columns.map(c => String(c))}
        widths={widths}
        padding={padding}
        bold
      />
      <Divider widths={widths} padding={padding} char='─' />
      {data.map((row, i) => (
        <Row
          key={i}
          cells={columns.map(c => format(row[c]))}
          widths={widths}
          padding={padding}
        />
      ))}
      <Divider widths={widths} padding={padding} char='─' />
    </Box>
  );
}

function Row({
  cells,
  widths,
  padding,
  bold,
}: {
  cells: string[];
  widths: number[];
  padding: number;
  bold?: boolean;
}) {
  const pad = ' '.repeat(padding);
  return (
    <Box>
      <Text>│</Text>
      {cells.map((cell, i) => (
        <React.Fragment key={i}>
          <Text bold={bold}>
            {pad}
            {cell.padEnd(widths[i] ?? 0)}
            {pad}
          </Text>
          <Text>│</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

function Divider({
  widths,
  padding,
  char,
}: {
  widths: number[];
  padding: number;
  char: string;
}) {
  const segments = widths.map(w => char.repeat(w + padding * 2));
  return <Text>{`┼${segments.join('┼')}┼`}</Text>;
}

function format(v: Cell): string {
  if (v === null || v === undefined) return '';
  return String(v);
}
