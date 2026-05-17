import { Command } from 'commander';

import { createListingCommand } from 'src/cli/commands/pipeline/listing.js';
import { createRunScriptsCommand } from 'src/cli/commands/pipeline/run-scripts.js';
import { createScriptingCommand } from 'src/cli/commands/pipeline/scripting.js';
import { createSeedingCommand } from 'src/cli/commands/pipeline/seeding.js';
import { createSourcingCommand } from 'src/cli/commands/pipeline/sourcing.js';

export function createPipelineCommand(): Command {
  const pipeline = new Command('pipeline').description('Pipeline operations');
  pipeline.addCommand(createSeedingCommand());
  pipeline.addCommand(createSourcingCommand());
  pipeline.addCommand(createListingCommand());
  pipeline.addCommand(createScriptingCommand());
  pipeline.addCommand(createRunScriptsCommand());
  return pipeline;
}
