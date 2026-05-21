import { Table, type Column } from 'src/tui/components/Table.js';
import type { SourceRow } from 'src/tui/queries.js';

const COLS: Column<SourceRow>[] = [
  { label: 'source', value: r => r.sourceName, min: 10, max: 24 },
  {
    label: 'active',
    value: r => (r.isActive == null ? '-' : r.isActive ? 'yes' : 'no'),
    min: 6,
    max: 7,
  },
  { label: 'script', value: r => (r.hasScript ? 'yes' : '—'), min: 6, max: 7 },
  { label: 'posts', value: r => String(r.jobPostCount), min: 5, max: 7 },
  { label: 'list url', value: r => r.listUrl ?? '—', min: 20, priority: 3 },
];

export function SourceList(props: {
  rows: SourceRow[];
  cursor: number;
  windowStart: number;
  visibleCount: number;
  width: number;
  active?: boolean;
}) {
  return (
    <Table
      {...props}
      columns={COLS}
      getKey={r => r.sourceId}
      emptyMessage='(no Source rows yet — run `jobfinder pipeline sourcing`)'
    />
  );
}
