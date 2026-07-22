import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { Command, Option } from 'commander';

/**
 * Directory where each `--harness` instance publishes how to reach its control
 * server, as `harness.<pid>.json`, so an agent can discover any running
 * instance without being told the port. Keyed by pid so concurrent TUIs don't
 * clobber each other's files. Each instance writes its file on startup and
 * removes it on exit.
 */
const HARNESS_INFO_DIR = '/tmp/jobfinder';
const harnessInfoPath = (pid: number): string =>
  `${HARNESS_INFO_DIR}/harness.${pid}.json`;

/** Delete discovery files whose owning process is gone (e.g. killed with -9). */
function sweepStaleHarnessInfo(): void {
  let entries: string[];
  try {
    entries = readdirSync(HARNESS_INFO_DIR);
  } catch {
    return; // Directory doesn't exist yet — nothing to sweep.
  }

  for (const name of entries) {
    const match = /^harness\.(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    try {
      process.kill(pid, 0); // Throws if the process is gone.
    } catch {
      try {
        rmSync(`${HARNESS_INFO_DIR}/${name}`, { force: true });
      } catch {
        // Best effort.
      }
    }
  }
}

export function createTuiCommand(): Command {
  return new Command('tui')
    .description(
      'Open the live dashboard: the pipeline funnel, the JobPost / Sources tables, and a recent-activity feed, all refreshing as the pipeline writes to the DB.'
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
    .action(async (opts: { harness: boolean; harnessPort?: number }) => {
      if (opts.harness) {
        // Mount the dashboard behind an HTTP control server and keep the
        // process alive until the TUI is quit (q/Esc) or the process is
        // signalled. In a real terminal the TUI is mirrored to the screen
        // and the human's keys are forwarded alongside injected ones; when
        // stdout is piped it runs headless for a pure agent.

        const infoPath = harnessInfoPath(process.pid);

        // Remove this instance's discovery file on every exit path. The
        // handlers are registered *before* the server starts — the file is
        // published as soon as the port binds, so a signal during startup
        // must already be able to clean it up (default signal termination
        // skips 'exit').
        const removeInfo = (): void => {
          try {
            rmSync(infoPath, { force: true });
          } catch {
            // Best effort: a stale file is harmless and gets swept later.
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
        const server = await startHarnessServer({
          port: opts.harnessPort,
          // Fires as soon as the server is listening, before the TUI is drawn.
          // Publish the discovery file and print the banner here so both are
          // available immediately, without waiting for the first frame.
          onListening: url => {
            mkdirSync(HARNESS_INFO_DIR, { recursive: true });
            // Tidy up files left behind by instances that died uncleanly.
            sweepStaleHarnessInfo();

            writeFileSync(
              infoPath,
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
                `  pid  ${process.pid}\n` +
                `  info ${infoPath}\n` +
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
      await renderApp();
    });
}
