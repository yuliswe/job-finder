import { Box, Text } from 'ink';
import React from 'react';

import type { PipelineStageStats } from 'src/tui/queries.js';

export function PipelineHeader({
  stats,
}: {
  stats: PipelineStageStats[] | null;
}) {
  if (!stats) {
    return (
      <Box>
        <Text dimColor>Loading pipeline stats…</Text>
      </Box>
    );
  }
  const labelWidth = Math.max(...stats.map(s => s.label.length));
  return (
    <Box flexDirection='column'>
      <Text bold color='magenta'>
        PIPELINE
      </Text>
      {stats.map(s => (
        <Text key={s.task}>
          {s.label.padEnd(labelWidth)}{' '}
          <Text color={progressColor(s)}>{progressBar(s.done, s.total)}</Text>{' '}
          {s.done}
          {s.total !== s.done ? ` / ${s.total}` : ''}
        </Text>
      ))}
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
