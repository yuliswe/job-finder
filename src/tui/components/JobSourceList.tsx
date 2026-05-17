import { Table, type Column } from 'src/tui/components/Table.js';
import type { JobSourceRow } from 'src/tui/queries.js';

const COLS: Column<JobSourceRow>[] = [
  { label: 'name', value: r => r.name, min: 10, max: 24 },
  { label: 'lists', value: r => String(r.jobListSourceCount), min: 5, max: 7 },
  { label: 'posts', value: r => String(r.jobPostCount), min: 5, max: 7 },
  { label: 'url', value: r => r.url, min: 20, priority: 3 },
];

export function JobSourceList(props: {
  rows: JobSourceRow[];
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
      emptyMessage='(no JobSource rows yet — run `jobfinder pipeline sourcing`)'
    />
  );
}
