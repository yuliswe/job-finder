import { Box, useApp, useInput } from 'ink';
import React, { useCallback, useState } from 'react';

import {
  getPipelineStats,
  getRecentActivity,
  listJobPosts,
  listSources,
  type JobPostSortKey,
} from 'src/tui/queries.js';
import { useLiveData } from 'src/tui/useLiveData.js';
import { ActivityFeed } from 'src/tui/components/ActivityFeed.js';
import { copyToClipboard } from 'src/tui/utils/clipboard.js';
import { Footer } from 'src/tui/components/Footer.js';
import { JobPostDetailScreen } from 'src/tui/components/JobPostDetailScreen.js';
import { PipelineHeader } from 'src/tui/components/PipelineHeader.js';
import { SourceJobsScreen } from 'src/tui/components/SourceJobsScreen.js';
import { TabBar } from 'src/tui/components/TabBar.js';
import { TabView } from 'src/tui/components/TabView.js';
import {
  ACTIVITY_ROWS,
  JOB_POST_SORTS,
  TAB_LABELS,
  type AppOptions,
  type AppTab,
} from 'src/tui/utils/types.js';

export type { AppOptions, AppTab };

export function App({ initial }: { initial: AppOptions }) {
  const { exit } = useApp();
  const [tab, setTab] = useState<AppTab>(initial.tab);
  const [sort, setSort] = useState<JobPostSortKey>(initial.sort);
  const [focus, setFocus] = useState<'pipeline' | 'table'>('table');
  const [pipelineCursor, setPipelineCursor] = useState(0);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);

  const stats = useLiveData(useCallback(() => getPipelineStats(), []));
  const activity = useLiveData(
    useCallback(() => getRecentActivity(ACTIVITY_ROWS), [])
  );

  const jobPosts = useLiveData(
    useCallback(() => listJobPosts({ sort, inScopeOnly: true }), [sort])
  );

  const sources = useLiveData(useCallback(() => listSources(), []));

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

      if (input === 's' && tab === 'jobs') {
        const idx = JOB_POST_SORTS.indexOf(sort);
        const next =
          JOB_POST_SORTS[(idx + 1) % JOB_POST_SORTS.length] ?? 'overall';

        setSort(next);
      }

      if (input === 'y') {
        copyToClipboard(`jobfinder tui --tab ${tab} --sort ${sort}`);
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
        initialSort={sort}
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
        onOpenSource={id => setOpenSourceId(id)}
      />
      <ActivityFeed rows={activity ?? []} />
      <Footer />
    </Box>
  );
}
