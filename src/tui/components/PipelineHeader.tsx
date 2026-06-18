import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';
import type { PipelineStageStats } from 'src/tui/queries.js';

const PULSE_MS = 500;
/** Truecolor orange; falls back to bright yellow on 256-color terminals. */
const PULSE_COLOR = '#ff8800';

const TASK_INFO: Record<PipelineStageStats['task'], string> = {
  seeding:
    'Seed URLs added to SourceSeed. Each seed is fetched and parsed to discover job-source companies.',
  sourcing:
    'For each processed seed, extract company/career pages and persist them as JobSource rows.',
  listing:
    'For each JobSource, locate paginated job-listing pages and record them as JobListSource rows.',
  scripting:
    'Generate a per-site parserScript that knows how to extract individual jobs from a JobListSource.',
  'run-scripts':
    'Execute each JobListSource parserScript to materialize JobPost rows for every listed job.',
  viewing:
    'Fetch each JobPost detail page so the full description and metadata are available (sets isProcessed).',
  evaluate:
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

  const labelWidth = Math.max(...stats.map(s => s.label.length));
  const rowsWidth = 2 + labelWidth + 1 + 18 + 1 + 22;
  const infoWidth = Math.max(20, cols - rowsWidth - 4);
  const selected = stats[cursor] ?? null;
  return (
    <Box flexDirection='column'>
      <Text bold color={focused ? 'cyan' : 'magenta'}>
        PIPELINE{focused ? ' ◂' : ''}
      </Text>
      <Box flexDirection='row'>
        <Box flexDirection='column' flexShrink={0}>
          {stats.map((s, i) => {
            const isCursor = focused && i === cursor;
            const segs = progressSegments(s);
            const running = s.started > 0;
            return (
              <Text key={s.task} inverse={isCursor}>
                {' '}
                {running ? (
                  <Text color={PULSE_COLOR} dimColor={!pulseOn}>
                    ●
                  </Text>
                ) : (
                  ' '
                )}{' '}
                {s.label.padEnd(labelWidth)}{' '}
                <Text color='red'>{'█'.repeat(segs.red)}</Text>
                <Text color='yellow'>{'█'.repeat(segs.yellow)}</Text>
                <Text color='green'>{'█'.repeat(segs.green)}</Text>
                <Text dimColor>{'░'.repeat(segs.empty)}</Text> {countSummary(s)}
                {s.outOfScope > 0 && (
                  <Text dimColor> ({s.outOfScope} out-of-scope)</Text>
                )}{' '}
              </Text>
            );
          })}
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

function countSummary(s: PipelineStageStats): string {
  const inScope = s.total - s.outOfScope;
  const parts = [`${s.done}✓`];
  if (s.noResult > 0) parts.push(`${s.noResult}∅`);
  if (s.failed > 0) parts.push(`${s.failed}✗`);
  return `${s.queued} / ${parts.join(' ')} / ${inScope}`;
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
