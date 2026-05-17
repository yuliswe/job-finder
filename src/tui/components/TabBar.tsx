import { Box, Text } from 'ink';
import React from 'react';

import type { JobPostSortKey } from 'src/tui/queries.js';
import { TAB_LABELS, type AppTab } from 'src/tui/utils/types.js';

export function TabBar({
  tab,
  sort,
  counts,
}: {
  tab: AppTab;
  sort: JobPostSortKey;
  counts: Record<AppTab, number>;
}) {
  return (
    <Box marginTop={1}>
      {TAB_LABELS.map(t => {
        const active = t.key === tab;
        return (
          <Box key={t.key} marginRight={2}>
            <Text bold={active} color={active ? 'cyan' : 'white'}>
              {active ? '▸ ' : '  '}
              {t.label}
            </Text>
            <Text dimColor> ({counts[t.key]})</Text>
          </Box>
        );
      })}
      <Box marginLeft={2}>
        <Text dimColor>sort: </Text>
        <Text color='cyan'>{sort}</Text>
      </Box>
    </Box>
  );
}
