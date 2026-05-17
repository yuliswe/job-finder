import { Box, Text } from 'ink';
import React from 'react';

import type { ActivityRow } from 'src/tui/queries.js';
import { stateColor } from 'src/tui/utils/format.js';

export function ActivityFeed({ rows }: { rows: ActivityRow[] }) {
  return (
    <Box flexDirection='column' marginTop={1}>
      <Text dimColor>{'─'.repeat(60)}</Text>
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
