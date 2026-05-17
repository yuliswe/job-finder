import { Box, Text } from 'ink';
import React from 'react';

import type { JobSourceRow } from 'src/tui/queries.js';

export function JobSourceDetail({ row }: { row: JobSourceRow | null }) {
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
