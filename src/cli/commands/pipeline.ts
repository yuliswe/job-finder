import { Command } from 'commander';

import { createApproveSeedsCommand } from 'src/cli/commands/pipeline/approve-seeds.js';
import { createEvaluateSkillMatchCommand } from 'src/cli/commands/pipeline/evaluate-skill-match.js';
import { createFillFormStageCommand } from 'src/cli/commands/pipeline/fill-form.js';
import { createIdentifyJobListUrlCommand } from 'src/cli/commands/pipeline/identify-job-list-url.js';
import { createApplyFiltersCommand } from 'src/cli/commands/pipeline/apply-filters.js';
import { createLearnToUseJobListCommand } from 'src/cli/commands/pipeline/learn-to-use-job-list.js';
import { createExploreHiringCompaniesCommand } from 'src/cli/commands/pipeline/explore-hiring-companies.js';
import { createResearchCompanyCommand } from 'src/cli/commands/pipeline/research-company.js';
import { createViewJobDetailCommand } from 'src/cli/commands/pipeline/view-job-detail.js';

export function createPipelineCommand(): Command {
  const pipeline = new Command('pipeline').description('Pipeline operations');
  pipeline.addCommand(createExploreHiringCompaniesCommand());
  pipeline.addCommand(createApproveSeedsCommand());
  pipeline.addCommand(createResearchCompanyCommand());
  pipeline.addCommand(createIdentifyJobListUrlCommand());
  pipeline.addCommand(createLearnToUseJobListCommand());
  pipeline.addCommand(createApplyFiltersCommand());
  pipeline.addCommand(createViewJobDetailCommand());
  pipeline.addCommand(createEvaluateSkillMatchCommand());
  pipeline.addCommand(createFillFormStageCommand());
  return pipeline;
}
