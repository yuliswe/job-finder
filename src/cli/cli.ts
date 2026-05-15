#!/usr/bin/env npx tsx

import { Command } from 'commander';

import { createCompletionScriptDumpCommand } from 'src/cli/commands/completion-script-dump.js';
import { createHelpMenuDumpCommand } from 'src/cli/commands/help-menu-dump.js';
import { createPipelineCommand } from 'src/cli/commands/pipeline.js';
import { createScrapeCommand } from 'src/cli/commands/scrape.js';
import { createSitesCommand } from 'src/cli/commands/sites.js';

const program = new Command();

program.name('jobfinder').description('CLI for python-jobspy').version('1.0.0');

program.addCommand(createScrapeCommand());
program.addCommand(createSitesCommand());
program.addCommand(createPipelineCommand());
program.addCommand(createCompletionScriptDumpCommand(program));
program.addCommand(createHelpMenuDumpCommand(program));

void (async () => {
  await program.parseAsync();
  process.exit(0);
})();
