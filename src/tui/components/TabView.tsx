import { Box, useInput } from 'ink';
import React, { useEffect } from 'react';

import { JobPostDetail } from 'src/tui/components/JobPostDetail.js';
import { JobPostList } from 'src/tui/components/JobPostList.js';
import { SourceDetail } from 'src/tui/components/SourceDetail.js';
import { SourceList } from 'src/tui/components/SourceList.js';
import { TagMenuBar } from 'src/tui/components/TagMenuBar.js';
import { useTerminalSize } from 'src/tui/components/useTerminalSize.js';
import {
  toggleJobPostBump,
  toggleJobPostTag,
  toggleSourceActive,
  type JobPostRow,
  type SourceRow,
} from 'src/tui/queries.js';
import { openUrl } from 'src/tui/utils/openUrl.js';
import { listTagOptions, tagOption } from 'src/tui/utils/tags.js';
import type { AppTab } from 'src/tui/utils/types.js';
import type { JobPostSortKey } from 'src/tui/queries.js';

export type TagPickerMode = 'add' | 'remove' | null;

export function TabView({
  tab,
  jobPosts,
  sources,
  jobsSort,
  stagesCount,
  activityCount,
  active = true,
  cursor,
  setCursor,
  tagPickerMode,
  setTagPickerMode,
  onOpenJob,
  onOpenSource,
}: {
  tab: AppTab;
  jobPosts: JobPostRow[] | null;
  sources: SourceRow[] | null;
  /** Active Jobs-tab sort. The JobPostList uses this to keep the
   * `overall` column's number aligned with the active ordering. */
  jobsSort: JobPostSortKey;
  stagesCount: number;
  activityCount: number;
  active?: boolean;
  /** Lifted to App so the Jobs-tab cursor survives drilling into a
   * JobPostDetailScreen and back out (TabView would otherwise reset on
   * remount). App resets it to 0 when switching tabs. */
  cursor: number;
  setCursor: React.Dispatch<React.SetStateAction<number>>;
  /** Lifted to App so App's outer `useInput` can deactivate while the
   * picker is open — otherwise Esc on the picker would exit the whole
   * TUI before TabView gets to handle it. `t` opens 'add' mode (every
   * configured tag), Shift+T opens 'remove' mode (only the row's
   * currently-applied tags). Jobs tab only. */
  tagPickerMode: TagPickerMode;
  setTagPickerMode: React.Dispatch<React.SetStateAction<TagPickerMode>>;
  /** Open the full-screen detail view for the given JobPost id. */
  onOpenJob?: (id: string) => void;
  /** Open the full-screen "jobs from this source" view. */
  onOpenSource?: (sourceId: string) => void;
}) {
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
    tab === 'jobs' ? (jobPosts?.length ?? 0) : (sources?.length ?? 0);

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

  // Page step scales with viewport: ~1/3 of the visible rows so the jump
  // feels proportional on both short and tall terminals. Floor + max(1)
  // guarantees at least one row of movement.
  const pageStep = Math.max(1, Math.floor(visibleCount / 3));

  useInput(
    (input, key) => {
      // Tag picker intercepts every key while open: shortcut letters toggle
      // the matching tag on the focused row; Esc cancels. Returning early
      // keeps the rest of the handler from firing on the same press. In
      // 'remove' mode the shortcut lookup is restricted to active tags so
      // an unrelated letter (matching a color the row doesn't have) is a
      // no-op rather than silently adding it.
      if (tagPickerMode != null) {
        if (key.escape || input === 'q') {
          setTagPickerMode(null);
          return;
        }

        const row = jobPosts?.[cursor];
        const candidates =
          tagPickerMode === 'add'
            ? listTagOptions()
            : (row?.tags.map(t => tagOption(t)) ?? []);

        const opt = candidates.find(o => o.shortcut === input.toLowerCase());

        if (opt && row) {
          void toggleJobPostTag(row.id, opt.key);
          setTagPickerMode(null);
        }

        return;
      }

      // Open the picker on `t` / Shift+T (Jobs tab only — no tags on Sources).
      if ((input === 't' || input === 'T') && tab === 'jobs') {
        if ((jobPosts?.length ?? 0) > 0) {
          setTagPickerMode(input === 'T' ? 'remove' : 'add');
        }

        return;
      }

      // Toggle the manual priority bump on the focused JobPost (Jobs tab only).
      if (input === 'b' && tab === 'jobs') {
        const row = jobPosts?.[cursor];
        if (row) void toggleJobPostBump(row.id);
        return;
      }

      // Page up: PageUp or Shift+U. Page down: PageDown or Shift+D.
      // Uppercase letters are universally detected (no terminal-escape
      // dependency) and leave plain 'u' / 'd' free for future bindings.
      if (key.pageUp || input === 'U') {
        setCursor(c => Math.max(0, c - pageStep));
        return;
      }

      if (key.pageDown || input === 'D') {
        setCursor(c => Math.min(rowCount - 1, c + pageStep));
        return;
      }

      if (key.upArrow) setCursor(c => Math.max(0, c - 1));
      if (key.downArrow) setCursor(c => Math.min(rowCount - 1, c + 1));
      if (key.return && tab === 'jobs') {
        const row = jobPosts?.[cursor];
        if (row && onOpenJob) onOpenJob(row.id);
      }

      if (key.return && tab === 'sources') {
        const row = sources?.[cursor];
        if (row && onOpenSource) onOpenSource(row.sourceId);
      }

      if (input === 'a' && tab === 'sources') {
        const row = sources?.[cursor];
        if (row) void toggleSourceActive(row);
      }

      if (input === 'l') {
        const url =
          tab === 'jobs'
            ? (jobPosts?.[cursor]?.url ?? null)
            : (sources?.[cursor]?.listUrl ??
              sources?.[cursor]?.sourceUrl ??
              null);

        if (url) openUrl(url);
      }
    },
    { isActive: active }
  );

  // Pin the detail pane to a fixed width and let the list expand to fill the
  // rest. Percentage splits caused list rows (padded to ~77 cols) to wrap on
  // narrower terminals, which is the wrap-induced log-update drift class.
  const DETAIL_WIDTH = 60;
  // 2 = paddingLeft on the detail box; -1 leaves a column of headroom so we
  // never write a row whose width exactly equals the terminal (which Ink's
  // log-update sometimes counts as overflowing).
  const listWidth = Math.max(20, terminalCols - DETAIL_WIDTH - 2 - 1);

  return (
    <Box flexDirection='column' marginTop={1}>
      <Box flexDirection='row'>
        <Box
          flexDirection='column'
          flexGrow={1}
          flexShrink={1}
          overflow='hidden'
        >
          {tab === 'jobs' && (
            <JobPostList
              rows={jobPosts ?? []}
              cursor={cursor}
              windowStart={windowStart}
              visibleCount={visibleCount}
              width={listWidth}
              sort={jobsSort}
              active={active}
            />
          )}
          {tab === 'sources' && (
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
          {tab === 'jobs' && <JobPostDetail row={jobPosts?.[cursor] ?? null} />}
          {tab === 'sources' && (
            <SourceDetail row={sources?.[cursor] ?? null} />
          )}
        </Box>
      </Box>
      {tagPickerMode != null && tab === 'jobs' && (
        <TagMenuBar
          activeTags={jobPosts?.[cursor]?.tags ?? []}
          mode={tagPickerMode}
        />
      )}
    </Box>
  );
}
