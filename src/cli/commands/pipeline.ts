import { Command } from 'commander';

import { createSeedCommand } from 'src/cli/commands/pipeline/seed.js';

export function createPipelineCommand(): Command {
  const pipeline = new Command('pipeline').description('Pipeline operations');
  pipeline.addCommand(createSeedCommand());
  return pipeline;
}
