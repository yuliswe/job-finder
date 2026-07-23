import { Box, Text } from 'ink';
import React from 'react';

import type { SourceRow } from 'src/tui/queries.js';
import { prettyUrl } from 'src/tui/utils/format.js';

export function SourceDetail({ row }: { row: SourceRow | null }) {
  if (!row) return <Text dimColor>(no row selected)</Text>;
  return (
    <Box flexDirection='column'>
      <Text bold color='cyan' wrap='truncate-end'>
        {row.sourceName}
      </Text>
      <Text>
        entity: <Text bold>JobSource</Text>
      </Text>
      <Text wrap='truncate-end'>
        id: <Text bold>{row.sourceId}</Text>
      </Text>
      {row.isOutOfScopeForListing && (
        <Text>
          out-of-scope:{' '}
          <Text bold color='yellow'>
            {row.outOfScopeReason ?? '—'}
          </Text>
        </Text>
      )}
      <Text dimColor wrap='truncate-end'>
        {prettyUrl(row.sourceUrl)}
      </Text>
      <Text>source active: {row.sourceIsActive ? 'yes' : 'no'}</Text>
      {row.sourceSummary && (
        <Box marginTop={1}>
          <Text>{row.sourceSummary}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection='column'>
        {row.listId ? (
          <>
            <Text bold>JobListSource</Text>
            <Text dimColor wrap='truncate-end'>
              JobListSource id: {row.listId}
            </Text>
            <Text dimColor wrap='truncate-end'>
              {prettyUrl(row.listUrl)}
            </Text>
            <Text>script: {row.hasScript ? 'present' : 'missing'}</Text>
            <Text>active: {row.listIsActive ? 'yes' : 'no'}</Text>
            <Text>JobPost rows: {row.jobPostCount}</Text>
            {row.listLocations && (
              <Text dimColor wrap='truncate-end'>
                locations: {row.listLocations}
              </Text>
            )}
            {row.listDivisions && (
              <Text dimColor wrap='truncate-end'>
                divisions: {row.listDivisions}
              </Text>
            )}
          </>
        ) : (
          <Text dimColor>(no JobListSource yet)</Text>
        )}
      </Box>
    </Box>
  );
}
