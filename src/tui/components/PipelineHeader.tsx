import { Box, Text } from 'ink';
import React from 'react';

import type { PipelineStageStats } from 'src/tui/queries.js';
import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';

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
  if (!stats) {
    return (
      <Box>
        <Text dimColor>Loading pipeline stats…</Text>
      </Box>
    );
  }
  const labelWidth = Math.max(...stats.map(s => s.label.length));
  // Pipeline rows visual width: label + space + 18-char bar + space + counts.
  const rowsWidth = labelWidth + 1 + 18 + 1 + 12;
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
            return (
              <Text key={s.task} inverse={isCursor}>
                {' '}
                {s.label.padEnd(labelWidth)}{' '}
                <Text color={progressColor(s)}>
                  {progressBar(s.done, s.total)}
                </Text>{' '}
                {s.done}
                {s.total !== s.done ? ` / ${s.total}` : ''}{' '}
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
              progress: {selected.done} / {selected.total}
            </Text>
          </Box>
        )}
      </Box>
      <Text dimColor>{'─'.repeat(60)}</Text>
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
