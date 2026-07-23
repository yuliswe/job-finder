import { Text } from 'ink';

import { Table, type Column } from 'src/tui/components/Table.js';
import type { JobPostRow, JobPostSortKey } from 'src/tui/queries.js';
import { fmtDaysAgo, fmtScore } from 'src/tui/utils/format.js';
import { tagOption } from 'src/tui/utils/tags.js';

/** The "overall" column reports the aggregate score the active sort is
 * keyed on — so when you switch to `excl. interest`, the column shows
 * `skill × location`, not the all-product. This keeps the column number
 * consistent with row ordering instead of contradicting it. */
function activeSortScore(r: JobPostRow, sort: JobPostSortKey): number | null {
  switch (sort) {
    case 'all':
      return r.overallScore;
    case 'interest':
      return r.interestScore;
    case 'skill':
      return r.skillScore;
    case 'location':
      return r.locationScore;
    case 'excl. interest':
      return r.skillScore != null
        ? r.skillScore * (r.locationScore ?? 1)
        : null;
    case 'excl. location':
      return r.skillScore != null && r.interestScore != null
        ? r.skillScore * r.interestScore
        : null;
  }
}

function buildColumns(sort: JobPostSortKey): Column<JobPostRow>[] {
  return [
    {
      label: 'overall',
      value: r => fmtScore(activeSortScore(r, sort)),
      min: 1,
    },
    { label: 'interest', value: r => fmtScore(r.interestScore), min: 1 },
    { label: 'skill', value: r => fmtScore(r.skillScore), min: 1 },
    { label: 'location', value: r => fmtScore(r.locationScore), min: 1 },
    {
      label: 'days',
      value: r => fmtDaysAgo(r.postedAt, r.postedAtSource),
      min: 1,
    },
    { label: 'company', value: r => r.company ?? '—', min: 7, max: 22 },
    {
      label: 'tags',
      // Plain projection: one '●' per tag. Drives column width and the
      // text rendered when `render` isn't used (shouldn't happen, but the
      // fallback keeps Table generic).
      value: r => (r.tags.length === 0 ? '·' : '●'.repeat(r.tags.length)),
      min: 1,
      max: 5,
      render: (r, width) => {
        const dots = r.tags.map((t, i) => {
          const opt = tagOption(t);
          return (
            <Text key={`${t}-${i}`} color={opt.inkColor}>
              ●
            </Text>
          );
        });

        const used = r.tags.length || 1;
        const padding = ' '.repeat(Math.max(0, width - used));
        return (
          <>
            {r.tags.length === 0 ? <Text dimColor>·</Text> : dots}
            {padding}
          </>
        );
      },
    },
    { label: 'title', value: r => r.title, min: 20, priority: 3 },
    { label: 'where', value: r => r.location ?? '—', min: 10, max: 20 },
    { label: 'status', value: r => r.status, min: 14, max: 38 },
  ];
}

export function JobPostList(props: {
  rows: JobPostRow[];
  cursor: number;
  windowStart: number;
  visibleCount: number;
  width: number;
  sort: JobPostSortKey;
  active?: boolean;
}) {
  const { sort, ...rest } = props;
  return (
    <Table
      {...rest}
      columns={buildColumns(sort)}
      getKey={r => r.id}
      isDim={r => r.isOutOfScopeForViewing}
      emptyMessage='(no JobPost rows — run `jobfinder pipeline run-scripts`)'
    />
  );
}
