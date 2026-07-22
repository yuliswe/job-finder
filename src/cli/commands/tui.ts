import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Command, Option } from 'commander';

import type { AppTab } from 'src/tui/App.js';
import type { JobPostSortKey, SourceSortKey } from 'src/tui/queries.js';

/**
 * Well-known path where `--harness` publishes how to reach its control server,
 * so an agent can discover a running instance without being told the port.
 * Written on startup, removed on exit.
 */
const HARNESS_INFO_PATH = '/tmp/jobfinder/harness.json';

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
        'open the live dashboard and also expose an HTTP control server so an agent can read the screen (GET /screen) and send keystrokes (POST /keys) to the same instance'
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
          // Mount the dashboard behind an HTTP control server and keep the
          // process alive until the TUI is quit (q/Esc) or the process is
          // signalled. In a real terminal the TUI is mirrored to the screen
          // and the human's keys are forwarded alongside injected ones; when
          // stdout is piped it runs headless for a pure agent.

          // Remove the discovery file on every exit path. The handlers are
          // registered *before* the server starts — the file is published as
          // soon as the port binds, so a signal during startup must already be
          // able to clean it up (default signal termination skips 'exit').
          const removeInfo = (): void => {
            try {
              rmSync(HARNESS_INFO_PATH, { force: true });
            } catch {
              // Best effort: a stale file is harmless and gets overwritten.
            }
          };

          process.once('exit', removeInfo);
          const shutdown = (): void => {
            removeInfo();
            process.exit(0);
          };

          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);

          const { startHarnessServer } = await import('src/tui/harness.js');
          const server = await startHarnessServer(initial, {
            port: opts.harnessPort,
            // Fires as soon as the server is listening, before the TUI is drawn.
            // Publish the discovery file and print the banner here so both are
            // available immediately, without waiting for the first frame.
            onListening: url => {
              mkdirSync(dirname(HARNESS_INFO_PATH), { recursive: true });

              writeFileSync(
                HARNESS_INFO_PATH,
                JSON.stringify(
                  {
                    url,
                    port: Number(new URL(url).port),
                    pid: process.pid,
                    screen: `${url}/screen`,
                    keys: `${url}/keys`,
                  },
                  null,
                  2
                ) + '\n'
              );

              process.stderr.write(
                `jobfinder tui harness listening on ${url}\n` +
                  `  info ${HARNESS_INFO_PATH}\n` +
                  `  GET  ${url}/screen   read the current screen\n` +
                  `  POST ${url}/keys     send keystrokes { keys?: string[], text?: string }\n`
              );
            },
            // Exit the process the moment the TUI quits. See onQuit's doc for
            // why this is done synchronously rather than after waitUntilExit.
            onQuit: () => process.exit(0),
          });

          await server.waitUntilExit();
          process.exit(0);
        }

        // Lazy-load Ink so spinning up the CLI for unrelated commands stays fast.
        const { renderApp } = await import('src/tui/index.js');

        // Await Ink's waitUntilExit so the CLI's trailing `process.exit(0)`
        // doesn't kill the dashboard before the user can interact with it.
        await renderApp(initial);
      }
    );
}
