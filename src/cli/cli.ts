#!/usr/bin/env npx tsx

import { Command } from 'commander';

import { createCompletionCommand } from 'src/cli/commands/completion.js';
import { createScrapeCommand } from 'src/cli/commands/scrape.js';
import { createSitesCommand } from 'src/cli/commands/sites.js';

const program = new Command();

program.name('cli').description('CLI for python-jobspy').version('1.0.0');

program.addCommand(createScrapeCommand());
program.addCommand(createSitesCommand());
program.addCommand(createCompletionCommand(program));

void (async () => {
  await program.parseAsync();
  process.exit(0);
})();
