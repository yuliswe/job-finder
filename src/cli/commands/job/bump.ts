import { Command, Option } from 'commander';

import {
  getJobPostPriorityBump,
  setJobPostPriorityBump,
} from 'src/db/jobPostPriority.js';
import { terminal } from 'src/utils/terminal.js';

type BumpOptions = { clear?: boolean };

export function createBumpCommand(): Command {
  return new Command('bump')
    .description(
      'Manually prioritize a JobPost so it clears the view-job-detail and evaluate stages ahead of the rest. The pickers order by the bump timestamp (most recently bumped first), so bumping several posts stacks them by recency. Pass --clear to remove the bump.'
    )
    .argument('<jobPostId>', 'ID of the JobPost to prioritize (or clear).')
    .addOption(
      new Option(
        '--clear',
        'Remove the priority bump on the JobPost instead of adding one.'
      )
    )
    .action(async (jobPostId: string, opts: BumpOptions) => {
      if (opts.clear) {
        await setJobPostPriorityBump(jobPostId, null);
        terminal.log(`Cleared the priority bump on JobPost ${jobPostId}.`);
        return;
      }

      const bumpedAt = new Date().toISOString();
      await setJobPostPriorityBump(jobPostId, bumpedAt);

      terminal.log(
        `Bumped JobPost ${jobPostId} to the front of the view-job-detail/evaluate queue (priorityBumpedAt=${bumpedAt}).`
      );

      // Read back so the caller sees the persisted value even if a concurrent
      // clear/bump raced in between.
      const current = await getJobPostPriorityBump(jobPostId);
      if (current !== bumpedAt) {
        terminal.warn(
          `Note: current priorityBumpedAt is ${current ?? 'null'} (a concurrent bump/clear may have run).`
        );
      }
    });
}
