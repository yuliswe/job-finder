import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { Table, type Column } from 'src/tui/components/Table.js';
import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';
import type { PipelineStageStats } from 'src/tui/queries.js';

const PULSE_MS = 500;
/** Truecolor orange; falls back to bright yellow on 256-color terminals. */
const PULSE_COLOR = '#ff8800';

const TASK_INFO: Record<PipelineStageStats['task'], string> = {
  'explore-hiring-companies':
    'Seed URLs added to SourceSeed. Each seed is fetched and parsed to discover job-source companies.',
  'research-company':
    'For each processed seed, extract company/career pages and persist them as JobSource rows.',
  'identify-job-list-url':
    'For each JobSource, locate paginated job-listing pages and record them as JobListSource rows.',
  'learn-to-use-job-list':
    'Generate a per-site parserScript that knows how to extract individual jobs from a JobListSource.',
  'apply-filters':
    'Execute each JobListSource parserScript to materialize JobPost rows for every listed job.',
  'view-job-detail':
    'Fetch each JobPost detail page so the full description and metadata are available (sets isProcessed).',
  'evaluate-skill-match':
    'Score every viewed JobPost (titleRelavency, interestScore, skillScore) into JobPostEval.',
};

export function PipelineHeader({
  stats,
  focused = false,
  cursor = 0,
}: {
  stats: PipelineStageStats[] | null;
  focused?: boolean;
  cursor?: number;
}) {
  const { cols } = useTerminalSize();
  const anyRunning = stats?.some(s => s.started > 0) ?? false;
  const pulseOn = usePulse(anyRunning);
  if (!stats) {
    return (
      <Box>
        <Text dimColor>Loading pipeline stats…</Text>
      </Box>
    );
  }

  const columns = buildColumns(pulseOn);
  const tableWidth = naturalWidth(columns, stats, DIVIDER);
  const infoWidth = Math.max(20, cols - tableWidth - 4);
  const selected = stats[cursor] ?? null;
  return (
    <Box flexDirection='column'>
      <Text bold color={focused ? 'cyan' : 'magenta'}>
        PIPELINE{focused ? ' ◂' : ''}
      </Text>
      <Box flexDirection='row'>
        <Box flexShrink={0}>
          <Table
            rows={stats}
            columns={columns}
            cursor={cursor}
            windowStart={0}
            visibleCount={stats.length}
            width={tableWidth}
            getKey={s => s.task}
            emptyMessage='No pipeline stages.'
            active={focused}
            separator={DIVIDER}
          />
        </Box>
        {focused && selected && (
          <Box
            flexDirection='column'
            marginLeft={2}
            width={infoWidth}
            overflow='hidden'
          >
            <Text bold color='cyan'>
              {selected.label}
            </Text>
            <Text>{TASK_INFO[selected.task]}</Text>
            <Text dimColor>
              done {selected.done} · no-result {selected.noResult} · failed{' '}
              {selected.failed} · queued {selected.queued} · started{' '}
              {selected.started} · out-of-scope {selected.outOfScope} · total{' '}
              {selected.total}
            </Text>
          </Box>
        )}
      </Box>
      <Text dimColor>{'─'.repeat(60)}</Text>
    </Box>
  );
}

/** Four-segment progress bar (over the in-scope subset only — out-of-scope
 * rows are surfaced in the count summary text instead):
 *   green  = succeeded with a result (terminal-success),
 *   yellow = ran successfully but produced no result (not_a_job_posting,
 *            no_*_found),
 *   red    = terminal failure (failed / aborted / script_error),
 *   empty  = not yet processed (queued / started / not yet enqueued).
 * Cells are allocated via the largest-remainder method so the four segments
 * always sum to exactly `width` — no trailing gap when nothing is pending.
 * Any non-zero count is guaranteed at least one cell (stolen from the largest
 * segment if rounding would otherwise drop it) so a single failure / no-result
 * is always visible. */
function progressSegments(
  s: PipelineStageStats,
  width = 18
): { green: number; yellow: number; red: number; empty: number } {
  const inScope = s.total - s.outOfScope;
  if (inScope <= 0) return { green: 0, yellow: 0, red: 0, empty: width };
  const pending = s.queued + s.started;
  const counts = [s.done, s.noResult, s.failed, pending];

  // 1. Largest-remainder rounding so cells sum to exactly `width`.
  const raw = counts.map(n => (n / inScope) * width);
  const out = raw.map(Math.floor);
  let leftover = width - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - out[i]!, n: counts[i]! }))
    .sort((a, b) => b.frac - a.frac || b.n - a.n);

  for (const entry of order) {
    if (leftover <= 0) break;
    out[entry.i]!++;
    leftover--;
  }

  // 2. Bump any non-zero count that rounded to 0 cells; pay for it by
  //    decrementing whichever segment currently has the most cells.
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! === 0 || out[i]! > 0) continue;
    let donor = -1;
    let donorCells = 1; // need >= 2 cells to spare one
    for (let j = 0; j < out.length; j++) {
      if (j !== i && out[j]! > donorCells) {
        donor = j;
        donorCells = out[j]!;
      }
    }

    if (donor >= 0) {
      out[donor]!--;
      out[i]!++;
    }
  }

  return { green: out[0]!, yellow: out[1]!, red: out[2]!, empty: out[3]! };
}

/** Vertical cell divider drawn between every column, with a space on each
 * side so the bars don't touch the content. */
const DIVIDER = ' │ ';

/** Fixed width of the progress-bar column, matching `progressSegments`. */
const BAR_WIDTH = 18;

/** The pipeline table's columns, in render order: a running-indicator dot, the
 * stage label, the four-segment progress bar, and the numeric outcome counts.
 * Built per render so the dot can close over the current `pulseOn` phase. */
function buildColumns(pulseOn: boolean): Column<PipelineStageStats>[] {
  return [
    {
      label: '',
      value: s => (s.started > 0 ? '●' : ' '),
      min: 1,
      max: 1,
      render: s =>
        s.started > 0 ? (
          <Text color={PULSE_COLOR} dimColor={!pulseOn}>
            ●
          </Text>
        ) : (
          ' '
        ),
    },
    { label: 'stage', value: s => s.label, min: 5 },
    {
      label: 'progress',
      value: s => plainBar(s),
      min: BAR_WIDTH,
      max: BAR_WIDTH,
      render: s => {
        const segs = progressSegments(s);
        return (
          <>
            <Text color='red'>{'█'.repeat(segs.red)}</Text>
            <Text color='yellow'>{'█'.repeat(segs.yellow)}</Text>
            <Text color='green'>{'█'.repeat(segs.green)}</Text>
            <Text dimColor>{'░'.repeat(segs.empty)}</Text>
          </>
        );
      },
    },
    { label: 'queued', value: s => `${s.queued}`, min: 1, align: 'right' },
    {
      label: 'done',
      value: s => `${s.done}`,
      min: 1,
      align: 'right',
      color: 'green',
    },
    {
      label: 'no-result',
      value: s => `${s.noResult}`,
      min: 1,
      align: 'right',
      color: 'yellow',
    },
    {
      label: 'failed',
      value: s => `${s.failed}`,
      min: 1,
      align: 'right',
      color: 'red',
    },
    {
      label: 'in-scope',
      value: s => `${s.total - s.outOfScope}`,
      min: 1,
      align: 'right',
    },
    {
      label: 'out-of-scope',
      value: s => `${s.outOfScope}`,
      min: 1,
      align: 'right',
      color: 'gray',
    },
  ];
}

/** Plain-text (colorless) rendering of the progress bar, used only for column
 * width budgeting and as the fallback when the rich renderer is unavailable. */
function plainBar(s: PipelineStageStats): string {
  const segs = progressSegments(s);
  return (
    '█'.repeat(segs.red + segs.yellow + segs.green) + '░'.repeat(segs.empty)
  );
}

/** The exact width the table needs so `Table`'s allocator hands every column
 * its natural content width and leaves no slack to stretch, keeping the grid
 * as tight as the hand-rolled layout was. */
function naturalWidth(
  columns: Column<PipelineStageStats>[],
  stats: PipelineStageStats[],
  separator: string
): number {
  const content = columns.reduce((sum, c) => {
    const contentMax = Math.max(
      c.label.length,
      ...stats.map(s => c.value(s).length)
    );

    const desired = Math.max(
      c.min,
      Math.min(contentMax, c.max ?? Number.POSITIVE_INFINITY)
    );

    return sum + desired;
  }, 0);

  // Mirror Table's own reservation: (N-1) separators plus 2 cols of
  // selection-highlight padding.
  return content + (columns.length - 1) * separator.length + 2;
}

/** Returns a boolean that flips every PULSE_MS while `active`. When inactive,
 * stays `true` so non-pulsing call sites see a stable value. */
function usePulse(active: boolean): boolean {
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!active) {
      setOn(true);
      return;
    }

    const id = setInterval(() => setOn(prev => !prev), PULSE_MS);
    return () => clearInterval(id);
  }, [active]);
  return on;
}
