import { Box, Text } from 'ink';
import React from 'react';

import type { JobListSourceRow } from 'src/tui/queries.js';

export function JobListSourceDetail({ row }: { row: JobListSourceRow | null }) {
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
