import { Box, useApp, useInput } from 'ink';
import React, { useCallback, useState } from 'react';

import {
  getPipelineStats,
  getRecentActivity,
  listJobListSources,
  listJobPosts,
  listJobSources,
  type JobPostSortKey,
} from 'src/tui/queries.js';
import { useLiveData } from 'src/tui/useLiveData.js';
import { ActivityFeed } from 'src/tui/components/ActivityFeed.js';
import { copyToClipboard } from 'src/tui/utils/clipboard.js';
import { Footer } from 'src/tui/components/Footer.js';
import { PipelineHeader } from 'src/tui/components/PipelineHeader.js';
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

  const stats = useLiveData(useCallback(() => getPipelineStats(), []));
  const activity = useLiveData(
    useCallback(() => getRecentActivity(ACTIVITY_ROWS), [])
  );
  const jobPosts = useLiveData(
    useCallback(() => listJobPosts({ sort }), [sort])
  );
  const jobSources = useLiveData(useCallback(() => listJobSources(), []));
  const jobListSources = useLiveData(
    useCallback(() => listJobListSources(), [])
  );

  // App-level keys only. Cursor (↑↓) lives inside TabView so arrow keys don't
  // re-render the chrome on every press. Ink supports multiple useInput hooks.
  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
    if (input === '\t' || key.rightArrow || key.leftArrow) {
      const delta = key.leftArrow ? -1 : 1;
      const idx = TAB_LABELS.findIndex(t => t.key === tab);
      const next =
        TAB_LABELS[(idx + delta + TAB_LABELS.length) % TAB_LABELS.length]!;
      setTab(next.key);
    }
    if (input === 's' && tab === 'jobpost') {
      const idx = JOB_POST_SORTS.indexOf(sort);
      const next = JOB_POST_SORTS[(idx + 1) % JOB_POST_SORTS.length] ?? 'score';
      setSort(next);
    }
    if (input === 'y') {
      copyToClipboard(`jobfinder tui --tab ${tab} --sort ${sort}`);
    }
  });

  return (
    <Box flexDirection='column'>
      <PipelineHeader stats={stats} />
      <TabBar
        tab={tab}
        sort={sort}
        counts={{
          jobpost: jobPosts?.length ?? 0,
          jobsource: jobSources?.length ?? 0,
          joblistsource: jobListSources?.length ?? 0,
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
        jobSources={jobSources}
        jobListSources={jobListSources}
        stagesCount={stats?.length ?? 0}
        activityCount={activity?.length ?? 0}
      />
      <ActivityFeed rows={activity ?? []} />
      <Footer />
    </Box>
  );
}
