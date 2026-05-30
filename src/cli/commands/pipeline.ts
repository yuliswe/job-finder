import { Command } from 'commander';

import { createApproveSeedsCommand } from 'src/cli/commands/pipeline/approve-seeds.js';
import { createEvaluateCommand } from 'src/cli/commands/pipeline/evaluate.js';
import { createListingCommand } from 'src/cli/commands/pipeline/listing.js';
import { createRunScriptsCommand } from 'src/cli/commands/pipeline/run-scripts.js';
import { createScriptingCommand } from 'src/cli/commands/pipeline/scripting.js';
import { createSeedingCommand } from 'src/cli/commands/pipeline/seeding.js';
import { createSourcingCommand } from 'src/cli/commands/pipeline/sourcing.js';
import { createViewingCommand } from 'src/cli/commands/pipeline/viewing.js';

export function createPipelineCommand(): Command {
  const pipeline = new Command('pipeline').description('Pipeline operations');
  pipeline.addCommand(createSeedingCommand());
  pipeline.addCommand(createApproveSeedsCommand());
  pipeline.addCommand(createSourcingCommand());
  pipeline.addCommand(createListingCommand());
  pipeline.addCommand(createScriptingCommand());
  pipeline.addCommand(createRunScriptsCommand());
  pipeline.addCommand(createViewingCommand());
  pipeline.addCommand(createEvaluateCommand());
  return pipeline;
}
