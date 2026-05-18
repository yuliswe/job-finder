import { sql } from 'kysely';

import {
  jobListSourceInActiveSource,
  jobPostInActiveSource,
} from 'src/db/activeSource.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { TASK_ORDER, type TriggerTask } from 'src/db/pipelineTrigger.js';
import { bumpLocalRevision } from 'src/tui/useLiveData.js';

export type PipelineStageStats = {
  task:
    | 'seeding'
    | 'sourcing'
    | 'listing'
    | 'scripting'
    | 'run-scripts'
    | 'viewing'
    | 'evaluate';
  done: number;
  total: number;
  label: string;
};

export type JobPostRow = {
  id: string;
  title: string;
  url: string;
  company: string | null;
  location: string | null;
  isRemote: number | null;
  postedAt: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  titleRelavency: number | null;
  interestScore: number | null;
  skillScore: number | null;
  combinedScore: number | null;
  description: string | null;
  summary: string | null;
};

export type SourceRow = {
  /** Composite of source + list id, stable for React keys. */
  rowKey: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  sourceIsActive: number;
  sourceIsProcessed: number;
  listId: string | null;
  listUrl: string | null;
  listIsActive: number | null;
  listIsProcessed: number | null;
  listLocations: string | null;
  listDivisions: string | null;
  hasScript: number;
  jobPostCount: number;
  /** Effective active flag — JobListSource's when present, else JobSource's. */
  isActive: number;
};

export type ActivityRow = {
  task: string;
  state: string;
  reason: string | null;
  createdAt: string;
  entity: string;
};

export type JobPostSortKey =
  | 'score'
  | 'postedAt'
  | 'company'
  | 'title'
  | 'salary';

export async function getPipelineStats(): Promise<PipelineStageStats[]> {
  // For each task X:
  //   total = count(PipelineTrigger WHERE task=X)
  //   done  = count(PipelineTrigger WHERE task=X AND isProcessed=true)
  // Child triggers are only enqueued when their parent succeeds, so `total`
  // already reflects "work that's eligible for this stage".
  return Promise.all(TASK_ORDER.map(triggerStats));
}

async function triggerStats(task: TriggerTask): Promise<PipelineStageStats> {
  // The base query for this task already filters to triggers whose owning
  // source tree is still active — toggling a Source/ListSource off shrinks
  // the bar in the TUI to match what the pipeline will actually process.
  const base = () => triggerQueryForTask(task);
  const [total, done] = await Promise.all([
    base()
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirst()
      .then(r => Number(r?.n ?? 0)),
    base()
      .where('isProcessed', '=', Bool.True)
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirst()
      .then(r => Number(r?.n ?? 0)),
  ]);
  return { task, label: task, done, total };
}

function triggerQueryForTask(task: TriggerTask) {
  const q = db.selectFrom('PipelineTrigger').where('task', '=', task);
  switch (task) {
    case 'seeding':
    case 'sourcing':
      // SourceSeed has no isActive concept.
      return q;
    case 'listing':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('JobSource')
            .select('JobSource.id')
            .whereRef('JobSource.id', '=', 'PipelineTrigger.ofJobSourceId')
            .where('JobSource.isActive', '=', Bool.True)
        )
      );
    case 'scripting':
    case 'run-scripts':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('JobListSource')
            .select('JobListSource.id')
            .whereRef(
              'JobListSource.id',
              '=',
              'PipelineTrigger.ofJobListSourceId'
            )
            .where(jobListSourceInActiveSource)
        )
      );
    case 'viewing':
    case 'evaluate':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('JobPost')
            .select('JobPost.id')
            .whereRef('JobPost.id', '=', 'PipelineTrigger.ofJobPostId')
            .where(jobPostInActiveSource)
        )
      );
  }
}

export async function listJobPosts(args: {
  sort: JobPostSortKey;
  limit?: number;
}): Promise<JobPostRow[]> {
  const { sort, limit = 500 } = args;

  let q = db
    .selectFrom('JobPost')
    .leftJoin('JobPostEval', 'JobPostEval.ofJobPostId', 'JobPost.id')
    .where(jobPostInActiveSource)
    .select([
      'JobPost.id as id',
      'JobPost.title as title',
      'JobPost.url as url',
      'JobPost.company as company',
      'JobPost.location as location',
      'JobPost.isRemote as isRemote',
      'JobPost.postedAt as postedAt',
      'JobPost.salaryMin as salaryMin',
      'JobPost.salaryMax as salaryMax',
      'JobPost.salaryCurrency as salaryCurrency',
      'JobPost.description as description',
      'JobPost.summary as summary',
      'JobPostEval.titleRelavency as titleRelavency',
      'JobPostEval.interestScore as interestScore',
      'JobPostEval.skillScore as skillScore',
    ]);

  switch (sort) {
    case 'score':
      q = q
        .orderBy('JobPostEval.interestScore', ob => ob.desc().nullsLast())
        .orderBy('JobPostEval.skillScore', ob => ob.desc().nullsLast())
        .orderBy('JobPostEval.titleRelavency', ob => ob.desc().nullsLast());
      break;
    case 'postedAt':
      q = q.orderBy('JobPost.postedAt', ob => ob.desc().nullsLast());
      break;
    case 'company':
      q = q.orderBy('JobPost.company', ob => ob.asc().nullsLast());
      break;
    case 'title':
      q = q.orderBy('JobPost.title', ob => ob.asc().nullsLast());
      break;
    case 'salary':
      q = q.orderBy('JobPost.salaryMax', ob => ob.desc().nullsLast());
      break;
  }

  const rows = await q.limit(limit).execute();
  return rows.map(r => ({
    ...r,
    combinedScore: combine(r.interestScore, r.skillScore),
  }));
}

function combine(interest: number | null, skill: number | null): number | null {
  if (interest != null && skill != null) return interest * skill;
  const parts = [interest, skill].filter((x): x is number => x != null);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export async function listSources(): Promise<SourceRow[]> {
  const rows = await db
    .selectFrom('JobSource')
    .leftJoin('JobListSource', 'JobListSource.ofJobSourceId', 'JobSource.id')
    .leftJoin('JobPost', 'JobPost.ofJobListSourceId', 'JobListSource.id')
    .leftJoin('PipelineTrigger as sourceTrigger', join =>
      join
        .onRef('sourceTrigger.ofJobSourceId', '=', 'JobSource.id')
        .on('sourceTrigger.task', '=', 'listing')
    )
    .leftJoin('PipelineTrigger as listTrigger', join =>
      join
        .onRef('listTrigger.ofJobListSourceId', '=', 'JobListSource.id')
        .on('listTrigger.task', '=', 'run-scripts')
    )
    .select([
      'JobSource.id as sourceId',
      'JobSource.name as sourceName',
      'JobSource.url as sourceUrl',
      'JobSource.isActive as sourceIsActive',
      'sourceTrigger.isProcessed as sourceIsProcessed',
      'JobListSource.id as listId',
      'JobListSource.url as listUrl',
      'JobListSource.isActive as listIsActive',
      'listTrigger.isProcessed as listIsProcessed',
      'JobListSource.locations as listLocations',
      'JobListSource.divisions as listDivisions',
      'JobListSource.parserScript as listParserScript',
      db.fn.count<number>('JobPost.id').as('jobPostCount'),
    ])
    .groupBy(['JobSource.id', 'JobListSource.id'])
    .orderBy(sql`"jobPostCount"`, 'desc')
    .orderBy('JobSource.name', 'asc')
    .orderBy('JobListSource.createdAt', 'asc')
    .execute();
  return rows.map(r => {
    const listIsActive = r.listIsActive ?? null;
    const sourceIsActive = r.sourceIsActive ?? 0;
    return {
      rowKey: `${r.sourceId}::${r.listId ?? ''}`,
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl,
      sourceIsActive,
      sourceIsProcessed: r.sourceIsProcessed ?? 0,
      listId: r.listId,
      listUrl: r.listUrl,
      listIsActive,
      listIsProcessed: r.listIsProcessed,
      listLocations: r.listLocations,
      listDivisions: r.listDivisions,
      hasScript: r.listParserScript ? 1 : 0,
      jobPostCount: Number(r.jobPostCount),
      isActive: r.listId ? (listIsActive ?? 0) : sourceIsActive,
    };
  });
}

export async function toggleSourceActive(row: SourceRow): Promise<void> {
  const next = row.isActive ? Bool.False : Bool.True;
  if (row.listId) {
    await db
      .updateTable('JobListSource')
      .set({ isActive: next })
      .where('id', '=', row.listId)
      .execute();
  } else {
    await db
      .updateTable('JobSource')
      .set({ isActive: next })
      .where('id', '=', row.sourceId)
      .execute();
  }
  bumpLocalRevision();
}

export async function getRecentActivity(limit = 20): Promise<ActivityRow[]> {
  const rows = await db
    .selectFrom('PipelineState')
    .select([
      'task',
      'state',
      'reason',
      'createdAt',
      'ofSourceSeedId',
      'ofJobSourceId',
      'ofJobListSourceId',
      'ofJobPostId',
    ])
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .execute();
  return rows.map(r => ({
    task: r.task,
    state: r.state,
    reason: r.reason,
    createdAt: r.createdAt,
    entity:
      r.ofJobPostId ??
      r.ofJobListSourceId ??
      r.ofJobSourceId ??
      r.ofSourceSeedId ??
      '',
  }));
}
