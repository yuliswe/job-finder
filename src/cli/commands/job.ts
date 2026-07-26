import { Command } from 'commander';
import { sql } from 'kysely';

import { createBumpCommand } from 'src/cli/commands/job/bump.js';
import { db } from 'src/db/index.js';
import { Bool } from 'src/db/customTypes.js';
import { terminal } from 'src/utils/terminal.js';

/** Matches the `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` default the schema uses
 * for createdAt/updatedAt, so a CLI-touched row stays lexicographically
 * comparable with pipeline-touched ones. There is no updatedAt trigger; app
 * code stamps it (see the write-db-migrations skill). */
const NOW = sql<string>`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Commands that act on a single JobPost by its id or url: the manual
 * out-of-scope override (`exclude` pushes a post out of scope for the
 * view-job-detail/evaluate pipeline and the TUI's default `in` filter the same way a
 * below-threshold relevancy score would; `include` reverses it) and the
 * manual priority bump (`bump` lifts a post ahead of the backlog in the
 * view-job-detail/evaluate pickers). */
export function createJobCommand(): Command {
  const job = new Command('job').description(
    'Act on a single job post (identified by its id or url).'
  );

  job.addCommand(createJobExcludeCommand());
  job.addCommand(createJobIncludeCommand());
  job.addCommand(createBumpCommand());

  return job;
}

function createJobExcludeCommand(): Command {
  return new Command('exclude')
    .description(
      'Manually mark a job post out of scope so the pipeline skips it and the TUI hides it from the default view.'
    )
    .argument('<id-or-url>', 'JobPost id (UUIDv7) or url.')
    .option('--reason <text>', 'Note recorded alongside the exclusion.')
    .action(async (idOrUrl: string, opts: { reason?: string }) => {
      const post = await findJobPost(idOrUrl);

      await db
        .updateTable('JobPost')
        .set({
          isManuallyExcluded: Bool.True,
          manualExclusionReason: opts.reason ?? 'excluded via CLI',
          updatedAt: NOW,
        })
        .where('id', '=', post.id)
        .execute();

      terminal.log(
        `Marked JobPost ${post.id} (${post.url}) out of scope${opts.reason ? ` — ${opts.reason}` : ''}.`
      );
    });
}

function createJobIncludeCommand(): Command {
  return new Command('include')
    .description(
      'Reverse a manual exclusion, letting the post re-enter scope (subject to the usual active-tree and relevancy gates).'
    )
    .argument('<id-or-url>', 'JobPost id (UUIDv7) or url.')
    .action(async (idOrUrl: string) => {
      const post = await findJobPost(idOrUrl);

      await db
        .updateTable('JobPost')
        .set({
          isManuallyExcluded: Bool.False,
          manualExclusionReason: null,
          updatedAt: NOW,
        })
        .where('id', '=', post.id)
        .execute();

      terminal.log(
        `Cleared manual exclusion on JobPost ${post.id} (${post.url}).`
      );
    });
}

/** Resolve a JobPost by its primary key or its unique url. Both columns are
 * unique, so at most one row matches. Throws when nothing matches so the CLI
 * exits non-zero. */
async function findJobPost(
  idOrUrl: string
): Promise<{ id: string; url: string }> {
  const post = await db
    .selectFrom('JobPost')
    .select(['id', 'url'])
    .where(eb => eb.or([eb('id', '=', idOrUrl), eb('url', '=', idOrUrl)]))
    .executeTakeFirst();

  if (!post) {
    throw new Error(`No JobPost found with id or url "${idOrUrl}".`);
  }

  return post;
}
