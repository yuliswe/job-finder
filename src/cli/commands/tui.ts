import { Command, Option } from 'commander';

import type { AppTab } from 'src/tui/App.js';
import type { JobPostSortKey, SourceSortKey } from 'src/tui/queries.js';

const TABS = ['jobs', 'sources'] as const satisfies readonly AppTab[];
const SORTS = [
  'all',
  'interest',
  'skill',
  'location',
  'excl. interest',
  'excl. location',
] as const satisfies readonly JobPostSortKey[];

const SOURCE_SORT_CHOICES = [
  'interest',
  'posts',
  'name',
] as const satisfies readonly SourceSortKey[];

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
        .default('all' satisfies JobPostSortKey)
    )
    .addOption(
      new Option('--sources-sort <key>', 'sort key for the Sources tab')
        .choices([...SOURCE_SORT_CHOICES])
        .default('interest' satisfies SourceSortKey)
    )
    .addOption(
      new Option(
        '--non-interactive',
        'print a one-shot plain-text snapshot of the dashboard (for agentic use) instead of opening the live view'
      ).default(false)
    )
    .addOption(
      new Option(
        '--harness',
        'run the dashboard headless behind an HTTP control server so an agent can read the screen (GET /screen) and send keystrokes (POST /keys)'
      ).default(false)
    )
    .addOption(
      new Option(
        '--harness-port <port>',
        'port for the harness control server (default: an ephemeral free port)'
      )
        .argParser(value => {
          const port = Number.parseInt(value, 10);
          if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new Error(`invalid --harness-port: ${value}`);
          }

          return port;
        })
        .implies({ harness: true })
    )
    .action(
      async (opts: {
        tab: AppTab;
        sort: JobPostSortKey;
        sourcesSort: SourceSortKey;
        nonInteractive: boolean;
        harness: boolean;
        harnessPort?: number;
      }) => {
        const initial = {
          tab: opts.tab,
          sort: opts.sort,
          sourcesSort: opts.sourcesSort,
        };

        if (opts.nonInteractive) {
          // Render once, snapshot the settled frame, and print it. No Ink
          // instance stays mounted, so the CLI's trailing `process.exit(0)`
          // ends the command cleanly.
          const { captureApp } = await import('src/tui/capture.js');
          process.stdout.write(await captureApp(initial));
          return;
        }

        if (opts.harness) {
          // Mount the dashboard headless behind an HTTP control server and
          // keep the process alive until an agent quits the TUI (q/Esc) or
          // the process is signalled.
          const { startHarnessServer } = await import('src/tui/harness.js');
          const server = await startHarnessServer(initial, {
            port: opts.harnessPort,
          });

          process.stderr.write(
            `jobfinder tui harness listening on ${server.url}\n` +
              `  GET  ${server.url}/screen   read the current screen\n` +
              `  POST ${server.url}/keys     send keystrokes { keys?: string[], text?: string }\n`
          );

          const shutdown = (): void => {
            void server.close().then(() => process.exit(0));
          };

          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);

          await server.waitUntilExit();
          return;
        }

        // Lazy-load Ink so spinning up the CLI for unrelated commands stays fast.
        const { renderApp } = await import('src/tui/index.js');

        // Await Ink's waitUntilExit so the CLI's trailing `process.exit(0)`
        // doesn't kill the dashboard before the user can interact with it.
        await renderApp(initial);
      }
    );
}
