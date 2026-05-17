import { spawn } from 'node:child_process';

import { Box, Text, useApp, useInput } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';

import {
  getPipelineStats,
  getRecentActivity,
  listJobListSources,
  listJobPosts,
  listJobSources,
  type ActivityRow,
  type JobListSourceRow,
  type JobPostRow,
  type JobPostSortKey,
  type JobSourceRow,
  type PipelineStageStats,
} from 'src/tui/queries.js';
import { useLiveData } from 'src/tui/useLiveData.js';

export type AppTab = 'jobpost' | 'jobsource' | 'joblistsource';
export type AppOptions = {
  tab: AppTab;
  sort: JobPostSortKey;
};

const TAB_LABELS: { key: AppTab; label: string }[] = [
  { key: 'jobpost', label: 'JobPost' },
  { key: 'jobsource', label: 'JobSource' },
  { key: 'joblistsource', label: 'JobListSource' },
];

const JOB_POST_SORTS: JobPostSortKey[] = [
  'score',
  'postedAt',
  'company',
  'title',
  'salary',
];

export function App({ initial }: { initial: AppOptions }) {
  const { exit } = useApp();
  const [tab, setTab] = useState<AppTab>(initial.tab);
  const [sort, setSort] = useState<JobPostSortKey>(initial.sort);
  const [cursor, setCursor] = useState(0);

  const stats = useLiveData(useCallback(() => getPipelineStats(), []));
  const activity = useLiveData(useCallback(() => getRecentActivity(8), []));

  const jobPosts = useLiveData(
    useCallback(() => listJobPosts({ sort }), [sort])
  );
  const jobSources = useLiveData(useCallback(() => listJobSources(), []));
  const jobListSources = useLiveData(
    useCallback(() => listJobListSources(), [])
  );

  const rowCount = useMemo(() => {
    if (tab === 'jobpost') return jobPosts?.length ?? 0;
    if (tab === 'jobsource') return jobSources?.length ?? 0;
    return jobListSources?.length ?? 0;
  }, [tab, jobPosts, jobSources, jobListSources]);

  // Keep cursor in range when data shrinks / tab changes.
  if (cursor > 0 && cursor >= rowCount) setCursor(Math.max(0, rowCount - 1));

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(rowCount - 1, c + 1));
    if (input === '\t' || key.rightArrow || key.leftArrow) {
      const delta = key.leftArrow ? -1 : 1;
      const idx = TAB_LABELS.findIndex(t => t.key === tab);
      const next =
        TAB_LABELS[(idx + delta + TAB_LABELS.length) % TAB_LABELS.length]!;
      setTab(next.key);
      setCursor(0);
    }
    if (input === 's' && tab === 'jobpost') {
      const idx = JOB_POST_SORTS.indexOf(sort);
      const next = JOB_POST_SORTS[(idx + 1) % JOB_POST_SORTS.length] ?? 'score';
      setSort(next);
    }
    if (input === 'y') {
      const cmd = `jobfinder tui --tab ${tab} --sort ${sort}`;
      copyToClipboard(cmd);
    }
  });

  return (
    <Box flexDirection='column'>
      <PipelineHeader stats={stats} />
      <TabBar
        tab={tab}
        sort={sort}
        counts={{
          jobpost: jobPosts?.length ?? 0,
          jobsource: jobSources?.length ?? 0,
          joblistsource: jobListSources?.length ?? 0,
        }}
      />
      <Box flexDirection='row' marginTop={1}>
        <Box flexDirection='column' width='60%'>
          {tab === 'jobpost' && (
            <JobPostList rows={jobPosts ?? []} cursor={cursor} />
          )}
          {tab === 'jobsource' && (
            <JobSourceList rows={jobSources ?? []} cursor={cursor} />
          )}
          {tab === 'joblistsource' && (
            <JobListSourceList rows={jobListSources ?? []} cursor={cursor} />
          )}
        </Box>
        <Box flexDirection='column' width='40%' paddingLeft={2}>
          {tab === 'jobpost' && (
            <JobPostDetail row={jobPosts?.[cursor] ?? null} />
          )}
          {tab === 'jobsource' && (
            <JobSourceDetail row={jobSources?.[cursor] ?? null} />
          )}
          {tab === 'joblistsource' && (
            <JobListSourceDetail row={jobListSources?.[cursor] ?? null} />
          )}
        </Box>
      </Box>
      <ActivityFeed rows={activity ?? []} />
      <Footer />
    </Box>
  );
}

function PipelineHeader({ stats }: { stats: PipelineStageStats[] | null }) {
  if (!stats) {
    return (
      <Box>
        <Text dimColor>Loading pipeline stats…</Text>
      </Box>
    );
  }
  const labelWidth = Math.max(...stats.map(s => s.label.length));
  return (
    <Box flexDirection='column' borderStyle='round' paddingX={1}>
      <Text bold color='magenta'>
        PIPELINE
      </Text>
      {stats.map(s => (
        <Box key={s.task}>
          <Text>{s.label.padEnd(labelWidth)} </Text>
          <Text color={progressColor(s)}>{progressBar(s.done, s.total)}</Text>
          <Text> </Text>
          <Text>
            {s.done}
            {s.total !== s.done ? ` / ${s.total}` : ''}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function progressBar(done: number, total: number, width = 18): string {
  if (total <= 0) return '·'.repeat(width);
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function progressColor(s: PipelineStageStats): 'green' | 'yellow' | 'red' {
  if (s.total === 0) return 'red';
  const ratio = s.done / s.total;
  if (ratio >= 0.9) return 'green';
  if (ratio >= 0.4) return 'yellow';
  return 'red';
}

function TabBar({
  tab,
  sort,
  counts,
}: {
  tab: AppTab;
  sort: JobPostSortKey;
  counts: Record<AppTab, number>;
}) {
  return (
    <Box marginTop={1}>
      {TAB_LABELS.map(t => {
        const active = t.key === tab;
        return (
          <Box key={t.key} marginRight={2}>
            <Text bold={active} color={active ? 'cyan' : 'white'}>
              {active ? '▸ ' : '  '}
              {t.label}
            </Text>
            <Text dimColor> ({counts[t.key]})</Text>
          </Box>
        );
      })}
      <Box marginLeft={2}>
        <Text dimColor>sort: </Text>
        <Text color='cyan'>{sort}</Text>
      </Box>
    </Box>
  );
}

function JobPostList({ rows, cursor }: { rows: JobPostRow[]; cursor: number }) {
  if (rows.length === 0)
    return (
      <Text dimColor>
        (no JobPost rows — run `jobfinder pipeline run-scripts`)
      </Text>
    );
  return (
    <Box flexDirection='column'>
      <Text bold>
        {pad('score', 6)}
        {pad('company', 22)}
        {pad('title', 50)}
        {pad('loc', 18)}
      </Text>
      {rows.slice(0, visibleRows()).map((r, i) => {
        const selected = i === cursor;
        return (
          <Text key={r.id} inverse={selected}>
            {pad(fmtScore(r.combinedScore), 6)}
            {pad(r.company ?? '—', 22)}
            {pad(r.title, 50)}
            {pad(r.location ?? '—', 18)}
          </Text>
        );
      })}
    </Box>
  );
}

function JobSourceList({
  rows,
  cursor,
}: {
  rows: JobSourceRow[];
  cursor: number;
}) {
  if (rows.length === 0)
    return (
      <Text dimColor>
        (no JobSource rows yet — run `jobfinder pipeline sourcing`)
      </Text>
    );
  return (
    <Box flexDirection='column'>
      <Text bold>
        {pad('name', 28)}
        {pad('url', 48)}
        {pad('lists', 7)}
        {pad('posts', 7)}
      </Text>
      {rows.slice(0, visibleRows()).map((r, i) => {
        const selected = i === cursor;
        return (
          <Text key={r.id} inverse={selected}>
            {pad(r.name, 28)}
            {pad(r.url, 48)}
            {pad(String(r.jobListSourceCount), 7)}
            {pad(String(r.jobPostCount), 7)}
          </Text>
        );
      })}
    </Box>
  );
}

function JobListSourceList({
  rows,
  cursor,
}: {
  rows: JobListSourceRow[];
  cursor: number;
}) {
  if (rows.length === 0)
    return (
      <Text dimColor>
        (no JobListSource rows yet — run `jobfinder pipeline listing`)
      </Text>
    );
  return (
    <Box flexDirection='column'>
      <Text bold>
        {pad('url', 64)}
        {pad('script', 7)}
        {pad('posts', 6)}
      </Text>
      {rows.slice(0, visibleRows()).map((r, i) => {
        const selected = i === cursor;
        return (
          <Text key={r.id} inverse={selected}>
            {pad(r.url, 64)}
            {pad(r.hasScript ? 'yes' : '—', 7)}
            {pad(String(r.jobPostCount), 6)}
          </Text>
        );
      })}
    </Box>
  );
}

function JobPostDetail({ row }: { row: JobPostRow | null }) {
  if (!row) return <Text dimColor>(no row selected)</Text>;
  return (
    <Box flexDirection='column'>
      <Text bold color='cyan'>
        {row.title}
      </Text>
      <Text>{row.company ?? '(unknown company)'}</Text>
      <Text dimColor>{row.url}</Text>
      <Box marginTop={1} flexDirection='column'>
        <Text>
          location: <Text bold>{row.location ?? '—'}</Text>
        </Text>
        <Text>
          remote:{' '}
          <Text bold>
            {row.isRemote === 1 ? 'yes' : row.isRemote === 0 ? 'no' : '?'}
          </Text>
        </Text>
        <Text>
          posted: <Text bold>{row.postedAt ?? '—'}</Text>
        </Text>
        <Text>
          salary:{' '}
          <Text bold>
            {fmtSalary(row.salaryMin, row.salaryMax, row.salaryCurrency)}
          </Text>
        </Text>
        <Text>
          scores: title={fmtScore(row.titleRelavency)} interest=
          {fmtScore(row.interestScore)} skill={fmtScore(row.skillScore)}
        </Text>
      </Box>
      {row.summary && (
        <Box marginTop={1}>
          <Text>{row.summary}</Text>
        </Box>
      )}
    </Box>
  );
}

function JobSourceDetail({ row }: { row: JobSourceRow | null }) {
  if (!row) return <Text dimColor>(no row selected)</Text>;
  return (
    <Box flexDirection='column'>
      <Text bold color='cyan'>
        {row.name}
      </Text>
      <Text dimColor>{row.url}</Text>
      <Box marginTop={1} flexDirection='column'>
        <Text>processed: {row.isProcessed ? 'yes' : 'no'}</Text>
        <Text>JobListSource rows: {row.jobListSourceCount}</Text>
        <Text>JobPost rows: {row.jobPostCount}</Text>
      </Box>
    </Box>
  );
}

function JobListSourceDetail({ row }: { row: JobListSourceRow | null }) {
  if (!row) return <Text dimColor>(no row selected)</Text>;
  return (
    <Box flexDirection='column'>
      <Text bold color='cyan'>
        {row.url}
      </Text>
      <Box marginTop={1} flexDirection='column'>
        <Text>parserScript: {row.hasScript ? 'present' : 'missing'}</Text>
        <Text>processed: {row.isProcessed ? 'yes' : 'no'}</Text>
        <Text>JobPost rows: {row.jobPostCount}</Text>
        {row.locations && <Text dimColor>locations: {row.locations}</Text>}
        {row.divisions && <Text dimColor>divisions: {row.divisions}</Text>}
      </Box>
    </Box>
  );
}

function ActivityFeed({ rows }: { rows: ActivityRow[] }) {
  return (
    <Box flexDirection='column' marginTop={1} borderStyle='round' paddingX={1}>
      <Text bold color='magenta'>
        RECENT ACTIVITY
      </Text>
      {rows.length === 0 && <Text dimColor>(no PipelineState rows yet)</Text>}
      {rows.map((r, i) => (
        <Text key={i}>
          <Text dimColor>{r.createdAt.slice(11, 19)} </Text>
          <Text color={stateColor(r.state)}>
            {r.task}/{r.state}
          </Text>{' '}
          <Text dimColor>{r.entity.slice(0, 12)}</Text>
          {r.reason ? <Text dimColor> — {r.reason.slice(0, 70)}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function stateColor(state: string): 'green' | 'yellow' | 'red' | 'white' {
  if (state === 'done' || state === 'success' || state === 'created')
    return 'green';
  if (state === 'failed' || state === 'script_error') return 'red';
  if (
    state === 'aborted' ||
    state === 'no_result_found' ||
    state === 'no_listing_found' ||
    state === 'no_source_found'
  )
    return 'yellow';
  return 'white';
}

function Footer() {
  const hints: { keys: string; label: string }[] = [
    { keys: '↑↓', label: 'nav' },
    { keys: '←→/Tab', label: 'tab' },
    { keys: 's', label: 'sort (JobPost)' },
    { keys: 'y', label: 'copy state cmd' },
    { keys: 'q/Esc', label: 'quit' },
  ];
  return (
    <Box marginTop={1}>
      {hints.map(h => (
        <Box key={h.keys} marginRight={2}>
          <Text color='cyan'>{h.keys}</Text>
          <Text> {h.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w - 1) + '… ';
  return s + ' '.repeat(w - s.length);
}

function fmtScore(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

function fmtSalary(
  min: number | null,
  max: number | null,
  currency: string | null
): string {
  if (min == null && max == null) return '—';
  const c = currency ? ` ${currency}` : '';
  if (min != null && max != null && min !== max) return `${min}–${max}${c}`;
  return `${min ?? max}${c}`;
}

function copyToClipboard(text: string): void {
  // macOS pbcopy, Linux xclip / wl-copy, Windows clip.
  const cmd =
    process.platform === 'darwin'
      ? 'pbcopy'
      : process.platform === 'win32'
        ? 'clip'
        : 'xclip';
  const args = cmd === 'xclip' ? ['-selection', 'clipboard'] : [];
  try {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {
      // No clipboard tool available — silently no-op.
    });
    p.stdin.end(text);
  } catch {
    // ignore
  }
}

function visibleRows(): number {
  // Roughly fill the viewport while leaving room for header/details/footer.
  const rows = (process.stdout.rows ?? 40) - 25;
  return Math.max(5, rows);
}
