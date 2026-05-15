import { Command } from 'commander';

import { createSeedingCommand } from 'src/cli/commands/pipeline/seeding.js';
import { createSourcingCommand } from 'src/cli/commands/pipeline/sourcing.js';

export function createPipelineCommand(): Command {
  const pipeline = new Command('pipeline').description('Pipeline operations');
  pipeline.addCommand(createSeedingCommand());
  pipeline.addCommand(createSourcingCommand());
  return pipeline;
}
