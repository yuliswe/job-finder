import { Command } from 'commander';

import { createSeedCommand } from 'src/cli/commands/pipeline/seed.js';
import { createSourcingCommand } from 'src/cli/commands/pipeline/sourcing.js';

export function createPipelineCommand(): Command {
  const pipeline = new Command('pipeline').description('Pipeline operations');
  pipeline.addCommand(createSeedCommand());
  pipeline.addCommand(createSourcingCommand());
  return pipeline;
}
