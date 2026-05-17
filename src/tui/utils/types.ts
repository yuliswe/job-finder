import type { JobPostSortKey } from 'src/tui/queries.js';

export type AppTab = 'jobpost' | 'jobsource' | 'joblistsource';

export type AppOptions = {
  tab: AppTab;
  sort: JobPostSortKey;
};

export const TAB_LABELS: { key: AppTab; label: string }[] = [
  { key: 'jobpost', label: 'JobPost' },
  { key: 'jobsource', label: 'JobSource' },
  { key: 'joblistsource', label: 'JobListSource' },
];

export const JOB_POST_SORTS: JobPostSortKey[] = [
  'score',
  'postedAt',
  'company',
  'title',
  'salary',
];

/** Default # of PipelineState rows shown in the activity feed. */
export const ACTIVITY_ROWS = 5;
