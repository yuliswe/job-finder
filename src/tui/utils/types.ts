import type { JobPostSortKey, SourceSortKey } from 'src/tui/queries.js';

export type AppTab = 'jobs' | 'sources';

export type AppOptions = {
  tab: AppTab;
  sort: JobPostSortKey;
  sourcesSort: SourceSortKey;
};

export const TAB_LABELS: { key: AppTab; label: string }[] = [
  { key: 'jobs', label: 'Jobs' },
  { key: 'sources', label: 'Sources' },
];

export const JOB_POST_SORTS: JobPostSortKey[] = [
  'all',
  'interest',
  'skill',
  'location',
  'excl. interest',
  'excl. location',
];

export const SOURCE_SORTS: SourceSortKey[] = ['interest', 'posts', 'name'];

/** Default # of PipelineState rows shown in the activity feed. */
export const ACTIVITY_ROWS = 5;
