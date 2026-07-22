import { Box, Text } from 'ink';
import React from 'react';

import type {
  JobPostSortKey,
  ScopeFilter,
  SourceSortKey,
} from 'src/tui/queries.js';
import { TAB_LABELS, type AppTab } from 'src/tui/utils/types.js';

const SCOPE_LABEL: Record<ScopeFilter, string> = {
  in: 'in-scope',
  all: 'all',
  out: 'out-of-scope only',
};

export function TabBar({
  tab,
  sort,
  sourcesSort,
  sourcesScopeFilter,
  jobsScopeFilter,
  counts,
  pid,
}: {
  tab: AppTab;
  sort: JobPostSortKey;
  sourcesSort: SourceSortKey;
  sourcesScopeFilter: ScopeFilter;
  jobsScopeFilter: ScopeFilter;
  counts: Record<AppTab, number>;
  /** This TUI's process id, shown right-aligned to identify the instance. */
  pid: number;
}) {
  const activeSort = tab === 'jobs' ? sort : sourcesSort;
  const activeScope = tab === 'jobs' ? jobsScopeFilter : sourcesScopeFilter;

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
        <Text color='cyan'>{activeSort}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>scope: </Text>
        <Text color='cyan'>{SCOPE_LABEL[activeScope]}</Text>
      </Box>
      {/* Spacer pushes the pid to the right edge so each running TUI is
          identifiable when several are open under one harness directory. */}
      <Box flexGrow={1} justifyContent='flex-end'>
        <Text dimColor>pid {pid}</Text>
      </Box>
    </Box>
  );
}
