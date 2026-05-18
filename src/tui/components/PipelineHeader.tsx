import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

import type { PipelineStageStats } from 'src/tui/queries.js';
import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';

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
  // Pipeline rows visual width: dot + space + label + space + 18-char bar +
  // space + counts.
  const rowsWidth = 2 + labelWidth + 1 + 18 + 1 + 16;
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
                <Text color='green'>{'█'.repeat(segs.green)}</Text>
                <Text color='yellow'>{'█'.repeat(segs.yellow)}</Text>
                <Text color='red'>{'█'.repeat(segs.red)}</Text>
                <Text dimColor>{'░'.repeat(segs.empty)}</Text>{' '}
                {countSummary(s)}{' '}
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
              {selected.started} · total {selected.total}
            </Text>
          </Box>
        )}
      </Box>
      <Text dimColor>{'─'.repeat(60)}</Text>
    </Box>
  );
}

/** Four-segment progress bar:
 *   green  = succeeded with a result (terminal-success),
 *   yellow = ran successfully but produced no result (not_a_job_posting,
 *            no_*_found),
 *   red    = terminal failure (failed / aborted / script_error),
 *   empty  = not yet processed (queued / started).
 * When processing completes, green + yellow + red fills the whole bar. */
function progressSegments(
  s: PipelineStageStats,
  width = 18
): { green: number; yellow: number; red: number; empty: number } {
  if (s.total <= 0) return { green: 0, yellow: 0, red: 0, empty: width };
  const raw = {
    green: (s.done / s.total) * width,
    yellow: (s.noResult / s.total) * width,
    red: (s.failed / s.total) * width,
  };
  // Largest-remainder rounding across the three filled segments so widths
  // sum to at most `Math.round(filledRatio * width)`. Simpler approach: round
  // each independently, then trim the segment with the largest fractional
  // overshoot if the sum exceeds the filled budget.
  let green = Math.round(raw.green);
  let yellow = Math.round(raw.yellow);
  let red = Math.round(raw.red);
  while (green + yellow + red > width) {
    if (green >= yellow && green >= red) green--;
    else if (yellow >= red) yellow--;
    else red--;
  }
  return { green, yellow, red, empty: width - green - yellow - red };
}

function countSummary(s: PipelineStageStats): string {
  const parts = [`${s.done}✓`];
  if (s.noResult > 0) parts.push(`${s.noResult}∅`);
  if (s.failed > 0) parts.push(`${s.failed}✗`);
  return `${parts.join(' ')} / ${s.total}`;
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
