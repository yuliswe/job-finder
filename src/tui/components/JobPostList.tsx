import { fmtScore } from 'src/tui/utils/format.js';
import { Table, type Column } from 'src/tui/components/Table.js';
import type { JobPostRow } from 'src/tui/queries.js';

const COLS: Column<JobPostRow>[] = [
  { label: 'overall', value: r => fmtScore(r.combinedScore), min: 1 },
  { label: 'interest', value: r => fmtScore(r.interestScore), min: 1 },
  { label: 'skill', value: r => fmtScore(r.skillScore), min: 1 },
  { label: 'company', value: r => r.company ?? '—', min: 8, max: 22 },
  { label: 'title', value: r => r.title, min: 20, priority: 3 },
  { label: 'location', value: r => r.location ?? '—', min: 10 },
];

export function JobPostList(props: {
  rows: JobPostRow[];
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
      emptyMessage='(no JobPost rows — run `jobfinder pipeline run-scripts`)'
    />
  );
}
