import { Command, Option } from 'commander';

import type { AppTab } from 'src/tui/App.js';
import type { JobPostSortKey } from 'src/tui/queries.js';

const TABS = ['jobs', 'sources'] as const satisfies readonly AppTab[];
const SORTS = [
  'score',
  'postedAt',
  'company',
  'title',
  'salary',
] as const satisfies readonly JobPostSortKey[];

export function createTuiCommand(): Command {
  return new Command('tui')
    .description(
      'Open the live dashboard. All flags are deep-link state — pass them to jump straight to a specific view.'
    )
    .addOption(
      new Option('--tab <tab>', 'initial tab')
        .choices([...TABS])
        .default('jobs' satisfies AppTab)
    )
    .addOption(
      new Option('--sort <key>', 'sort key for the JobPost tab')
        .choices([...SORTS])
        .default('score' satisfies JobPostSortKey)
    )
    .action(async (opts: { tab: AppTab; sort: JobPostSortKey }) => {
      // Lazy-load Ink so spinning up the CLI for unrelated commands stays fast.
      const { renderApp } = await import('src/tui/index.js');
      // Await Ink's waitUntilExit so the CLI's trailing `process.exit(0)`
      // doesn't kill the dashboard before the user can interact with it.
      await renderApp({ tab: opts.tab, sort: opts.sort });
    });
}
