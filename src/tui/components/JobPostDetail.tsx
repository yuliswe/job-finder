import { Box, Text } from 'ink';
import React from 'react';

import type { JobPostRow } from 'src/tui/queries.js';
import { fmtSalary, fmtScore } from 'src/tui/utils/format.js';

export function JobPostDetail({ row }: { row: JobPostRow | null }) {
  if (!row) return <Text dimColor>(no row selected)</Text>;
  return (
    <Box flexDirection='column'>
      <Text bold color='cyan'>
        {row.title}
      </Text>
      <Text>{row.company ?? '(unknown company)'}</Text>
      <Text dimColor>{row.url}</Text>
      <Box marginTop={1} flexDirection='column'>
        <Text>
          location: <Text bold>{row.location ?? '—'}</Text>
        </Text>
        <Text>
          remote:{' '}
          <Text bold>
            {row.isRemote === 1 ? 'yes' : row.isRemote === 0 ? 'no' : '?'}
          </Text>
        </Text>
        <Text>
          posted: <Text bold>{row.postedAt ?? '—'}</Text>
        </Text>
        <Text>
          salary:{' '}
          <Text bold>
            {fmtSalary(row.salaryMin, row.salaryMax, row.salaryCurrency)}
          </Text>
        </Text>
        <Text>
          skill: <Text bold>{fmtScore(row.skillScore)}</Text>
        </Text>
        <Text>
          interest: <Text bold>{fmtScore(row.interestScore)}</Text>
        </Text>
        <Text>
          location: <Text bold>{fmtScore(row.locationScore)}</Text>
        </Text>
        <Text>
          overall: <Text bold>{fmtScore(row.overallScore)}</Text>
        </Text>
      </Box>
      {row.summary && (
        <Box marginTop={1}>
          <Text>{row.summary}</Text>
        </Box>
      )}
    </Box>
  );
}
