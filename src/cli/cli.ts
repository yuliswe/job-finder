#!/usr/bin/env npx tsx

import { Command } from 'commander';

import { createCompletionCommand } from 'src/cli/commands/completion.js';
import { createExportCommand } from 'src/cli/commands/export.js';
import { createHelpMenuDumpCommand } from 'src/cli/commands/help-menu-dump.js';
import { createInitCommand } from 'src/cli/commands/init.js';
import { createPipelineCommand } from 'src/cli/commands/pipeline.js';
import { createResetCommand } from 'src/cli/commands/reset.js';
import { createStartPipelineCommand } from 'src/cli/commands/start-pipeline.js';
import { createTrackCommand } from 'src/cli/commands/track.js';
import { createTuiCommand } from 'src/cli/commands/tui.js';

const program = new Command();

program
  .name('jobfinder')
  .description(
    'Job discovery and application-tracking pipeline that scrapes postings (via python-jobspy), seeds and sources companies, tracks applications, and exports results, with a TUI dashboard'
  )
  .version('1.0.0');

program.addCommand(createInitCommand());
program.addCommand(createPipelineCommand());
program.addCommand(createResetCommand());
program.addCommand(createStartPipelineCommand());
program.addCommand(createExportCommand());
program.addCommand(createTrackCommand());
program.addCommand(createTuiCommand());
program.addCommand(createCompletionCommand(program));
program.addCommand(createHelpMenuDumpCommand(program));

void (async () => {
  await program.parseAsync();
  process.exit(0);
})();
