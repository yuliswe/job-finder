import type { JobPostSortKey } from 'src/tui/queries.js';

export type AppTab = 'jobs' | 'sources';

export type AppOptions = {
  tab: AppTab;
  sort: JobPostSortKey;
};

export const TAB_LABELS: { key: AppTab; label: string }[] = [
  { key: 'jobs', label: 'Jobs' },
  { key: 'sources', label: 'Sources' },
];

export const JOB_POST_SORTS: JobPostSortKey[] = [
  'overall',
  'interest',
  'skill',
];

/** Default # of PipelineState rows shown in the activity feed. */
export const ACTIVITY_ROWS = 5;
