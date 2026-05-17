import { Box, Text } from 'ink';
import React from 'react';

import type { SourceRow } from 'src/tui/queries.js';

export function SourceDetail({ row }: { row: SourceRow | null }) {
  if (!row) return <Text dimColor>(no row selected)</Text>;
  return (
    <Box flexDirection='column'>
      <Text bold color='cyan'>
        {row.sourceName}
      </Text>
      <Text dimColor>{row.sourceUrl}</Text>
      <Text>processed: {row.sourceIsProcessed ? 'yes' : 'no'}</Text>
      <Box marginTop={1} flexDirection='column'>
        {row.listId ? (
          <>
            <Text bold>JobListSource</Text>
            <Text dimColor>{row.listUrl}</Text>
            <Text>script: {row.hasScript ? 'present' : 'missing'}</Text>
            <Text>processed: {row.listIsProcessed ? 'yes' : 'no'}</Text>
            <Text>JobPost rows: {row.jobPostCount}</Text>
            {row.listLocations && (
              <Text dimColor>locations: {row.listLocations}</Text>
            )}
            {row.listDivisions && (
              <Text dimColor>divisions: {row.listDivisions}</Text>
            )}
          </>
        ) : (
          <Text dimColor>(no JobListSource yet)</Text>
        )}
      </Box>
    </Box>
  );
}
