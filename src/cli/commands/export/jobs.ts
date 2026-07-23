import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Command, Option } from 'commander';

import { toCsv } from 'src/cli/utils/csv.js';
import {
  listJobPosts,
  type JobPostRow,
  type JobPostSortKey,
} from 'src/tui/queries.js';
import { JOB_POST_SORTS } from 'src/tui/utils/types.js';
import { terminal } from 'src/utils/terminal.js';

const DEFAULT_OUTPUT_PATH = './jobs.out.csv';

/** Columns written to the CSV, in order. Mirrors the TUI Jobs list +
 * extra metadata that's only useful out-of-app (URL, salary range, ids,
 * etc.). Keep stable so downstream tooling / spreadsheets can pin column
 * order. */
const CSV_COLS = [
  'id',
  'title',
  'url',
  'company',
  'location',
  'isRemote',
  'postedAt',
  'salaryMin',
  'salaryMax',
  'salaryCurrency',
  'overallScore',
  'interestScore',
  'skillScore',
  'locationScore',
  'titleRelavency',
  'status',
  'summary',
] as const satisfies readonly (keyof JobPostRow)[];

type ExportJobsOptions = {
  sort: JobPostSortKey;
};

export function createExportJobsCommand(): Command {
  return new Command('jobs')
    .description(
      'Export fully-evaluated JobPost rows (status=Done) as CSV — i.e. only posts that cleared the in-scope filter AND have description + interestScore + skillScore + locationScore filled in.'
    )
    .argument(
      '[output]',
      'Output CSV path. Defaults to ./jobs.out.csv (matches the *.out.csv gitignore so it stays out of version control).',
      DEFAULT_OUTPUT_PATH
    )
    .addOption(
      new Option('-s, --sort <key>', 'Sort key (mirrors `jobfinder tui`).')
        .choices([...JOB_POST_SORTS])
        .default('all' satisfies JobPostSortKey)
    )
    .action(async (output: string, opts: ExportJobsOptions) => {
      await runExportJobs({ output, opts });
    });
}

async function runExportJobs(args: {
  output: string;
  opts: ExportJobsOptions;
}): Promise<void> {
  const absolutePath = resolve(args.output);

  if (existsSync(absolutePath)) {
    const ok = await confirmOverwrite(absolutePath);
    if (!ok) {
      terminal.warn(
        'Aborted — file already exists and overwrite was declined.'
      );
      return;
    }
  }

  const allRows = await listJobPosts({ sort: args.opts.sort, scope: 'in' });
  // Only fully-processed posts: a `Done: <stage>` status means in active
  // tree, titleRelavency cleared, viewing populated description, and evaluate
  // produced an interestScore. Anything earlier in the pipeline reports a
  // `Queued:`/`Out-of-scope:` status and gets omitted, so the CSV is meant
  // for downstream analysis, not progress tracking (the TUI is for that).
  const rows = allRows.filter(r => r.status.startsWith('Done:'));
  const csv = toCsv(rows, CSV_COLS);
  await writeFile(absolutePath, csv);

  terminal.log(
    `Wrote ${rows.length} of ${allRows.length} in-scope JobPost row(s) to ${absolutePath} (Done only)`
  );
}

/** Read y/N on stdin. Returns true only when the user types y/yes (case-
 * insensitive). Empty input / anything else returns false (safe default). */
async function confirmOverwrite(path: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${path} already exists. Overwrite? [y/N] `
    );

    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
