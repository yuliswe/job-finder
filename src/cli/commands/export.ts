import { Command } from 'commander';

import { createExportJobsCommand } from 'src/cli/commands/export/jobs.js';

export function createExportCommand(): Command {
  const exportCmd = new Command('export').description(
    'Export pipeline data for use outside the CLI / TUI (CSV, etc.).'
  );

  exportCmd.addCommand(createExportJobsCommand());
  return exportCmd;
}
