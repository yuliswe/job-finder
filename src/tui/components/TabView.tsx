import { Box, useInput } from 'ink';
import { useEffect, useState } from 'react';

import { JobPostDetail } from 'src/tui/components/JobPostDetail.js';
import { JobPostList } from 'src/tui/components/JobPostList.js';
import { SourceDetail } from 'src/tui/components/SourceDetail.js';
import { SourceList } from 'src/tui/components/SourceList.js';
import type { AppTab } from 'src/tui/utils/types.js';
import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';
import type { JobPostRow, SourceRow } from 'src/tui/queries.js';

export function TabView({
  tab,
  jobPosts,
  sources,
  stagesCount,
  activityCount,
  active = true,
}: {
  tab: AppTab;
  jobPosts: JobPostRow[] | null;
  sources: SourceRow[] | null;
  stagesCount: number;
  activityCount: number;
  active?: boolean;
}) {
  const [cursor, setCursor] = useState(0);
  const { rows: terminalRows, cols: terminalCols } = useTerminalSize();

  // Count what we render so the table fits the viewport.
  //   PipelineHeader: 1 (title) + stagesCount + 1 (separator)
  //   TabBar:         1 (marginTop) + 1 (content)
  //   TabView:        1 (marginTop) + 1 (table header) + 1 (window footer)
  //   ActivityFeed:   1 (marginTop) + 1 (separator) + 1 (title) + activityCount
  //   Footer:         1 (marginTop) + 1 (content)
  const SAFETY = 2;
  const chromeLines = 2 + stagesCount + 2 + 3 + 3 + activityCount + 2 + SAFETY;
  const visibleCount = Math.max(3, terminalRows - chromeLines);

  const rowCount =
    tab === 'jobpost' ? (jobPosts?.length ?? 0) : (sources?.length ?? 0);

  // Slide the visible window to keep cursor in view.
  const windowStart = Math.max(
    0,
    Math.min(
      Math.max(0, rowCount - visibleCount),
      cursor - Math.floor(visibleCount / 2)
    )
  );

  // Clamp cursor when data shrinks. Must be in useEffect, not render body.
  useEffect(() => {
    if (cursor > 0 && cursor >= rowCount) {
      setCursor(Math.max(0, rowCount - 1));
    }
  }, [cursor, rowCount]);

  useInput(
    (_input, key) => {
      if (key.upArrow) setCursor(c => Math.max(0, c - 1));
      if (key.downArrow) setCursor(c => Math.min(rowCount - 1, c + 1));
    },
    { isActive: active }
  );

  // Pin the detail pane to a fixed width and let the list expand to fill the
  // rest. Percentage splits caused list rows (padded to ~77 cols) to wrap on
  // narrower terminals, which is the wrap-induced log-update drift class.
  const DETAIL_WIDTH = 44;
  // 2 = paddingLeft on the detail box; -1 leaves a column of headroom so we
  // never write a row whose width exactly equals the terminal (which Ink's
  // log-update sometimes counts as overflowing).
  const listWidth = Math.max(20, terminalCols - DETAIL_WIDTH - 2 - 1);

  return (
    <Box flexDirection='row' marginTop={1}>
      <Box flexDirection='column' flexGrow={1} flexShrink={1} overflow='hidden'>
        {tab === 'jobpost' && (
          <JobPostList
            rows={jobPosts ?? []}
            cursor={cursor}
            windowStart={windowStart}
            visibleCount={visibleCount}
            width={listWidth}
            active={active}
          />
        )}
        {tab === 'source' && (
          <SourceList
            rows={sources ?? []}
            cursor={cursor}
            windowStart={windowStart}
            visibleCount={visibleCount}
            width={listWidth}
            active={active}
          />
        )}
      </Box>
      <Box
        flexDirection='column'
        width={DETAIL_WIDTH}
        height={visibleCount + 2}
        paddingLeft={2}
        overflow='hidden'
      >
        {tab === 'jobpost' && (
          <JobPostDetail row={jobPosts?.[cursor] ?? null} />
        )}
        {tab === 'source' && <SourceDetail row={sources?.[cursor] ?? null} />}
      </Box>
    </Box>
  );
}
