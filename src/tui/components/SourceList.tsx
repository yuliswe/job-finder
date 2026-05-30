import { Table, type Column } from 'src/tui/components/Table.js';
import type { SourceRow } from 'src/tui/queries.js';
import { fmtScore, prettyUrl } from 'src/tui/utils/format.js';

const COLS: Column<SourceRow>[] = [
  { label: 'interest', value: r => fmtScore(r.sourceInterestScore), min: 1 },
  { label: 'source', value: r => r.sourceName, min: 10, max: 24 },
  {
    label: 'active',
    value: r => (r.isActive == null ? '-' : r.isActive ? 'yes' : 'no'),
    min: 6,
    max: 7,
  },
  { label: 'script', value: r => (r.hasScript ? 'yes' : '—'), min: 6, max: 7 },
  { label: 'posts', value: r => String(r.jobPostCount), min: 5, max: 7 },
  {
    label: 'url',
    value: r => prettyUrl(r.listUrl ?? r.sourceUrl),
    min: 20,
    priority: 3,
  },
  { label: 'status', value: r => r.status, min: 12, max: 28 },
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
      isDim={r => r.isOutOfScopeForListing}
      emptyMessage='(no Source rows yet — run `jobfinder pipeline sourcing`)'
    />
  );
}
