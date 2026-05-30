import { Box, useApp, useInput } from 'ink';
import { useCallback, useState } from 'react';

import { ActivityFeed } from 'src/tui/components/ActivityFeed.js';
import { Footer } from 'src/tui/components/Footer.js';
import { JobPostDetailScreen } from 'src/tui/components/JobPostDetailScreen.js';
import { PipelineHeader } from 'src/tui/components/PipelineHeader.js';
import { SourceJobsScreen } from 'src/tui/components/SourceJobsScreen.js';
import { TabBar } from 'src/tui/components/TabBar.js';
import { TabView } from 'src/tui/components/TabView.js';
import {
  getPipelineStats,
  getRecentActivity,
  listJobPosts,
  listSources,
  type JobPostSortKey,
  type ScopeFilter,
  type SourceSortKey,
} from 'src/tui/queries.js';
import { useLiveData } from 'src/tui/useLiveData.js';
import { copyToClipboard } from 'src/tui/utils/clipboard.js';
import {
  ACTIVITY_ROWS,
  JOB_POST_SORTS,
  SOURCE_SORTS,
  TAB_LABELS,
  type AppOptions,
  type AppTab,
} from 'src/tui/utils/types.js';

export type { AppOptions, AppTab };

export function App({ initial }: { initial: AppOptions }) {
  const { exit } = useApp();
  const [tab, setTab] = useState<AppTab>(initial.tab);
  const [sort, setSort] = useState<JobPostSortKey>(initial.sort);
  const [sourcesSort, setSourcesSort] = useState<SourceSortKey>(
    initial.sourcesSort
  );

  // Scope filter for each tab. Both tabs share the same 'in' | 'all' | 'out'
  // shape (see ScopeFilter):
  //   - Sources keys off inScopeForListing (active + interestScore >=
  //     PIPELINE_LISTING_MIN_INTEREST_SCORE).
  //   - Jobs keys off inScopeForViewing (active tree + titleRelavency >=
  //     PIPELINE_VIEWING_MIN_TITLE_RELEVANCY).
  // 'o' toggles in ↔ all, Shift+O toggles in ↔ out. Out-of-scope rows
  // surfaced by 'all' render dim; 'out' shows them as the only rows.
  const [sourcesScopeFilter, setSourcesScopeFilter] =
    useState<ScopeFilter>('in');

  const [jobsScopeFilter, setJobsScopeFilter] = useState<ScopeFilter>('in');

  const [focus, setFocus] = useState<'pipeline' | 'table'>('table');
  const [pipelineCursor, setPipelineCursor] = useState(0);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  // Cursor/sort for SourceJobsScreen live here (not inside the screen) so
  // they survive its unmount when the user drills into a JobPostDetailScreen
  // and back out. Both reset when a *different* source is opened from the
  // Sources tab.
  const [sourceJobsCursor, setSourceJobsCursor] = useState(0);
  const [sourceJobsSort, setSourceJobsSort] = useState<JobPostSortKey>(sort);

  const stats = useLiveData(useCallback(() => getPipelineStats(), []));
  const activity = useLiveData(
    useCallback(() => getRecentActivity(ACTIVITY_ROWS), [])
  );

  const jobPosts = useLiveData(
    useCallback(
      () => listJobPosts({ sort, scope: jobsScopeFilter }),
      [sort, jobsScopeFilter]
    )
  );

  const sources = useLiveData(
    useCallback(
      () => listSources({ sort: sourcesSort, scope: sourcesScopeFilter }),
      [sourcesSort, sourcesScopeFilter]
    )
  );

  // App-level keys only. Cursor (↑↓) lives inside TabView so arrow keys don't
  // re-render the chrome on every press. Ink supports multiple useInput hooks.
  const stageCount = stats?.length ?? 0;
  const openJob =
    openJobId == null
      ? null
      : (jobPosts?.find(j => j.id === openJobId) ?? null);

  const openSource =
    openSourceId == null
      ? null
      : (sources?.find(s => s.sourceId === openSourceId) ?? null);

  useInput(
    (input, key) => {
      if (input === 'q') {
        exit();
        return;
      }

      if (key.escape) {
        // ESC returns to table focus when pipeline is focused; otherwise exits.
        if (focus === 'pipeline') {
          setFocus('table');
          return;
        }

        exit();
        return;
      }

      if (input === 'p') {
        setFocus(f => (f === 'pipeline' ? 'table' : 'pipeline'));
        return;
      }

      if (focus === 'pipeline') {
        if (key.upArrow) {
          setPipelineCursor(c => Math.max(0, c - 1));
        }

        if (key.downArrow) {
          setPipelineCursor(c => Math.min(Math.max(0, stageCount - 1), c + 1));
        }

        return;
      }

      if (input === '\t' || key.rightArrow || key.leftArrow) {
        const delta = key.leftArrow ? -1 : 1;
        const idx = TAB_LABELS.findIndex(t => t.key === tab);
        const next =
          TAB_LABELS[(idx + delta + TAB_LABELS.length) % TAB_LABELS.length]!;

        setTab(next.key);
      }

      if ((input === 's' || input === 'S') && tab === 'jobs') {
        const delta = input === 'S' ? -1 : 1;
        const idx = JOB_POST_SORTS.indexOf(sort);
        const next =
          JOB_POST_SORTS[
            (idx + delta + JOB_POST_SORTS.length) % JOB_POST_SORTS.length
          ] ?? 'overall';

        setSort(next);
      }

      if ((input === 's' || input === 'S') && tab === 'sources') {
        const delta = input === 'S' ? -1 : 1;
        const idx = SOURCE_SORTS.indexOf(sourcesSort);
        const next =
          SOURCE_SORTS[
            (idx + delta + SOURCE_SORTS.length) % SOURCE_SORTS.length
          ] ?? 'interest';

        setSourcesSort(next);
      }

      if (input === 'y') {
        copyToClipboard(
          `jobfinder tui --tab ${tab} --sort ${sort} --sources-sort ${sourcesSort}`
        );
      }

      if (input === 'o' || input === 'O') {
        // 'o': toggle in ↔ all. Shift+O: toggle in ↔ out. From the other
        // non-default mode, both keys land on the requested mode (so 'o'
        // from 'out' goes to 'all', not back to 'in'). The setter that
        // fires depends on which tab is focused.
        const next =
          input === 'o'
            ? (v: ScopeFilter) => (v === 'all' ? 'in' : 'all')
            : (v: ScopeFilter) => (v === 'out' ? 'in' : 'out');

        if (tab === 'sources') setSourcesScopeFilter(next);
        else if (tab === 'jobs') setJobsScopeFilter(next);
      }
    },
    // App-level keys go silent while a layered screen (JobPost detail or
    // SourceJobs) is open — those screens own all input.
    { isActive: openJob == null && openSource == null }
  );

  if (openJob) {
    return (
      <JobPostDetailScreen row={openJob} onClose={() => setOpenJobId(null)} />
    );
  }

  if (openSource) {
    return (
      <SourceJobsScreen
        source={openSource}
        sort={sourceJobsSort}
        onSortChange={setSourceJobsSort}
        cursor={sourceJobsCursor}
        onCursorChange={setSourceJobsCursor}
        onClose={() => setOpenSourceId(null)}
        onOpenJob={id => setOpenJobId(id)}
      />
    );
  }

  return (
    <Box flexDirection='column'>
      <PipelineHeader
        stats={stats}
        focused={focus === 'pipeline'}
        cursor={pipelineCursor}
      />
      <TabBar
        tab={tab}
        sort={sort}
        sourcesSort={sourcesSort}
        sourcesScopeFilter={sourcesScopeFilter}
        jobsScopeFilter={jobsScopeFilter}
        counts={{
          jobs: jobPosts?.length ?? 0,
          sources: sources?.length ?? 0,
        }}
      />
      {/*
        key={tab} forces TabView to remount on tab switch — resets the cursor
        to 0 without App having to manage that state.
      */}
      <TabView
        key={tab}
        tab={tab}
        jobPosts={jobPosts}
        sources={sources}
        stagesCount={stats?.length ?? 0}
        activityCount={activity?.length ?? 0}
        active={focus === 'table'}
        onOpenJob={id => setOpenJobId(id)}
        onOpenSource={id => {
          // Fresh source session: reset cursor + seed sort from the Jobs
          // tab's current sort. (When the user drills into JobPostDetail and
          // back out *within* the same session, these are preserved.)
          setSourceJobsCursor(0);
          setSourceJobsSort(sort);
          setOpenSourceId(id);
        }}
      />
      <ActivityFeed rows={activity ?? []} />
      <Footer />
    </Box>
  );
}
