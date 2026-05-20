import { Box, Text, useInput } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

import { JobPostDetail } from 'src/tui/components/JobPostDetail.js';
import { JobPostList } from 'src/tui/components/JobPostList.js';
import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';
import {
  type JobPostSortKey,
  type SourceRow,
  listJobPosts,
} from 'src/tui/queries.js';
import { useLiveData } from 'src/tui/useLiveData.js';
import { JOB_POST_SORTS } from 'src/tui/utils/types.js';
import { openUrl } from 'src/tui/utils/openUrl.js';

/** Full-screen "jobs from this source" view, opened with Enter on a row in
 * the Sources tab. Same list-on-left, detail-on-right layout as the main
 * Jobs tab — with the company name pinned in the header. */
export function SourceJobsScreen({
  source,
  initialSort,
  onClose,
  onOpenJob,
}: {
  source: SourceRow;
  initialSort: JobPostSortKey;
  onClose: () => void;
  onOpenJob: (id: string) => void;
}) {
  const [sort, setSort] = useState<JobPostSortKey>(initialSort);
  const [cursor, setCursor] = useState(0);
  const { rows: termRows, cols: termCols } = useTerminalSize();

  // Only refetch when sort / source.sourceId changes — useCallback keeps the
  // identity stable so useLiveData doesn't re-run every render. `inScopeOnly`
  // matches the per-source count shown in the Sources list (relevancy
  // threshold + active-tree).
  const fetchJobs = useCallback(
    () =>
      listJobPosts({
        sort,
        ofJobSourceId: source.sourceId,
        inScopeOnly: true,
      }),
    [sort, source.sourceId]
  );

  const jobPosts = useLiveData(fetchJobs);

  // Chrome: 1 header + 1 url + 1 hint + 1 marginTop + 1 table header + 1 footer.
  const SAFETY = 2;
  const chromeLines = 6 + SAFETY;
  const visibleCount = Math.max(3, termRows - chromeLines);

  const rowCount = jobPosts?.length ?? 0;
  const windowStart = Math.max(
    0,
    Math.min(
      Math.max(0, rowCount - visibleCount),
      cursor - Math.floor(visibleCount / 2)
    )
  );

  // Clamp cursor when data shrinks.
  useEffect(() => {
    if (cursor > 0 && cursor >= rowCount) {
      setCursor(Math.max(0, rowCount - 1));
    }
  }, [cursor, rowCount]);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }

    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }

    if (key.downArrow) {
      setCursor(c => Math.min(rowCount - 1, c + 1));
      return;
    }

    if (key.return) {
      const row = jobPosts?.[cursor];
      if (row) onOpenJob(row.id);
      return;
    }

    if (input === 's') {
      const idx = JOB_POST_SORTS.indexOf(sort);
      const next =
        JOB_POST_SORTS[(idx + 1) % JOB_POST_SORTS.length] ?? 'overall';

      setSort(next);
      return;
    }

    if (input === 'l') {
      const url =
        jobPosts?.[cursor]?.url ?? source.listUrl ?? source.sourceUrl ?? null;

      if (url) openUrl(url);
      return;
    }
  });

  // Pin the detail pane and let the list fill the rest. Same widths as the
  // main TabView so the company-jobs layout feels identical.
  const DETAIL_WIDTH = 44;
  const listWidth = Math.max(20, termCols - DETAIL_WIDTH - 2 - 1);

  return (
    <Box flexDirection='column' width={termCols} height={termRows}>
      <Text bold color='cyan' wrap='truncate-end'>
        {source.sourceName}
      </Text>
      <Text dimColor wrap='truncate-end'>
        {source.listUrl ?? source.sourceUrl}
      </Text>
      <Text dimColor>
        {rowCount} job{rowCount === 1 ? '' : 's'} · sort{' '}
        <Text color='cyan'>{sort}</Text>
      </Text>
      <Box flexDirection='row' marginTop={1}>
        <Box
          flexDirection='column'
          flexGrow={1}
          flexShrink={1}
          overflow='hidden'
        >
          <JobPostList
            rows={jobPosts ?? []}
            cursor={cursor}
            windowStart={windowStart}
            visibleCount={visibleCount}
            width={listWidth}
            active
          />
        </Box>
        <Box
          flexDirection='column'
          width={DETAIL_WIDTH}
          height={visibleCount + 2}
          paddingLeft={2}
          overflow='hidden'
        >
          <JobPostDetail row={jobPosts?.[cursor] ?? null} />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          <Text color='cyan'>↑↓</Text> nav · <Text color='cyan'>Enter</Text>{' '}
          open · <Text color='cyan'>s</Text> sort · <Text color='cyan'>l</Text>{' '}
          open url · <Text color='cyan'>Esc/q</Text> back
        </Text>
      </Box>
    </Box>
  );
}
