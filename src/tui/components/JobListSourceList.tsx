import { Table, type Column } from 'src/tui/components/Table.js';
import type { JobListSourceRow } from 'src/tui/queries.js';

const COLS: Column<JobListSourceRow>[] = [
  { label: 'script', value: r => (r.hasScript ? 'yes' : '—'), min: 6, max: 8 },
  { label: 'posts', value: r => String(r.jobPostCount), min: 5, max: 7 },
  { label: 'url', value: r => r.url, min: 20, priority: 2 },
];

export function JobListSourceList(props: {
  rows: JobListSourceRow[];
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
      getKey={r => r.id}
      emptyMessage='(no JobListSource rows yet — run `jobfinder pipeline listing`)'
    />
  );
}
