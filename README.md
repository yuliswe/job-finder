# Start development

## MacOS

If you are setting up the repo for the first time, following these steps:

1. Make sure your ~/.zshrc file has the following lines:

```
   if [ -f ./.zshrc ] && [ \$(pwd) != ~ ]; then
     source ./.zshrc
   fi
```

2. Run the following commands: (You only need to do this once.)

```
   ./initenv.bash
```

3. Start a new terminal session.

# CLI

The CLI at `src/cli/bin/cli` wraps the `python-jobspy` library. Run via `npm run cli -- <args>` or directly with `./src/cli/bin/cli <args>`.

## `pipeline listing`

For each unprocessed `JobSource`, open the company URL and BFS the same-domain links the LLM ranks most likely to lead to a careers/jobs page (capped at `PIPELINE_LISTING_BFS_MAX_DEPTH`). The first page the LLM classifies as a listing page is inserted as a new `JobListSource` row with an empty `parserScript` placeholder. `pipeline scripting` fills the script in later. The `JobSource` is always marked `isProcessed` after the attempt to avoid re-running BFS.

```bash
./src/cli/bin/cli pipeline listing --start
```

Requires:

- A locally installed Chrome/Chromium (run `npx patchright install chromium` once if not).
- `LLM_LISTING_MODEL` set in `jobfinder.config.js`.

## `pipeline scripting`

For each unprocessed `JobListSource` (i.e. one whose `parserScript` has not yet been generated), reload the listing page and ask the LLM to emit a JavaScript snippet defining `listLocations()` and `async searchJobs(locations, keywords)`. The script is executed inside the page in a feedback loop — corrective feedback is fed back to the LLM until `searchJobs` returns a non-empty `{ jobTitle, url }[]`. On success, the script is stored in `JobListSource.parserScript` and the row is marked `isProcessed`. On failure, the row is left unprocessed so it can be retried (after tweaking prompts, raising `PIPELINE_LISTING_BFS_MAX_DEPTH`, etc.).

```bash
./src/cli/bin/cli pipeline scripting --start
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_LISTING_MODEL` set in `jobfinder.config.js`.

## `pipeline run-scripts`

For every `JobListSource` with a validated `parserScript`, reload the listing page, call the script's `listLocations()` and `listDivisions()` to enumerate the page's actual filter values, ask the LLM to map the user-supplied `--division` and `--location` strings to subsets of those values, then invoke `searchJobs()` with the picks and insert every returned `{ jobTitle, url }` into `JobPost` (ON CONFLICT(url) DO NOTHING). Each row is recorded in `PipelineState` with `task='run-scripts'` and state `script_error` / `no_result_found` / `success`.

```bash
./src/cli/bin/cli pipeline run-scripts -d engineering -l "Toronto, ON" --start
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_LISTING_MODEL` set in `jobfinder.config.js`.

## `pipeline viewing`

For each unprocessed `JobPost` (i.e. `isProcessed=false`), open the posting URL, clean the page HTML, and ask the LLM to extract structured fields (`title`, `company`, `location`, `description`, `isRemote`, `jobType`, `postedAt`, `salaryMin`/`salaryMax`/`salaryCurrency`/`salaryInterval`, `summary`). The row is updated with whatever fields the LLM populates and marked `isProcessed`. Each row is recorded in `PipelineState` with `task='viewing'` and state `done` / `failed`.

```bash
jobfinder pipeline viewing --start
```

Pass `--all` to re-queue every qualifying `JobPost` regardless of pipeline state — including ones already `done` / `not_a_job_posting` / `failed`. Useful after a prompt change.

```bash
jobfinder pipeline viewing --all --start
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_VIEWING_MODEL` set in `jobfinder.config.js`.

## `pipeline sourcing`

For each distinct `name` in `SourceSeed`, take the top 3 most recent rows (by `createdAt`), open each URL with headless Puppeteer, and ask the LLM to identify the hiring company. Insert each discovered company (hostname-normalized URL, unique) into `JobSource`.

```bash
jobfinder pipeline sourcing --start
```

By default, `sourcing`, `listing`, `scripting`, `run-scripts`, `viewing`, and `evaluate` only queue the rows they select — nothing is processed until you either pass `--start` or let `jobfinder start-pipeline` drain the queues. This makes it cheap to stage work first and process it later in one orchestrated run:

```bash
# Queue failed viewing rows now, process everything queued later:
jobfinder pipeline viewing --include-failed
jobfinder start-pipeline

# Or queue and process in one invocation:
jobfinder pipeline viewing --include-failed --start
```

All pipeline subcommands (except `seeding`) accept `--all` to re-queue every qualifying parent regardless of pipeline state — including ones already `done` / `failed` / `aborted`. Useful after a prompt change. Available on `sourcing`, `listing`, `scripting`, `run-scripts`, `viewing`, `evaluate`:

```bash
jobfinder pipeline sourcing --all --start
jobfinder pipeline evaluate --all --start
```

Each of those subcommands also accepts a `--<parent-table>-id <id>` flag to force a single record onto the queue regardless of pipeline state or qualification (add `--start` to process it immediately):

- `sourcing --source-seed-id <id>`
- `listing --job-source-id <id>`
- `scripting --job-list-source-id <id>`
- `run-scripts --job-list-source-id <id>`
- `viewing --job-post-id <id>`
- `evaluate --job-post-id <id>`

```bash
jobfinder pipeline viewing --job-post-id 0192...abcd --start
jobfinder pipeline run-scripts --job-list-source-id 0192...abcd --start
```

Requires:

- A locally installed Chrome/Chromium (run `npx puppeteer browsers install chrome` once if not).
- `LLM_SOURCING_MODEL` set in `jobfinder.config.js`.

## `pipeline seeding`

Read `seeds/interests.md`, ask the LLM to translate the interests into a `python-jobspy` call, run the call in a feedback loop (the LLM gets a chance to fix failures), then insert each unique result into the `SourceSeed` table.

```bash
./src/cli/bin/cli pipeline seeding
```

Requires:

- `OPENROUTER_API_KEY` set in the environment.
- `LLM_SEEDING_MODEL` set in `src/llm/config.ts` (empty by default).
- `seeds/interests.md` populated with the user's job-search interests.

## `start-pipeline`

Run sourcing, listing, scripting, run-scripts, viewing, and evaluate concurrently in independent loops until every queue drains. Each loop re-iterates immediately when its previous iteration processed ≥1 row, and sleeps 5s only when it found nothing to do. The orchestrator exits once every task has finished an idle iteration with no productive work happening anywhere in between — so it's the right thing to leave running unattended after `pipeline seeding` + `pipeline approve-seeds`.

```bash
jobfinder start-pipeline

# Also retry every in-scope row whose latest state is NOT done
# (failed / aborted / no_result / etc.) — applied once on each task's
# first iteration via the same picker semantics as
# `jobfinder pipeline <task> --include-failed`. Subsequent iterations
# run in default queued-only mode so a transient failure inside the
# run is not retried forever.
jobfinder start-pipeline --include-failed
```

Each browser-using task (sourcing, listing, scripting, run-scripts, viewing) holds its own long-lived Chromium instance for the loop's lifetime — no per-poll cold starts. Per-row failures (`PIPELINE_STATE.FAILED`/`ABORTED`/etc.) stay failed; retry them with `--include-failed` on a fresh `start-pipeline`, or with the relevant subcommand and `--include-failed` / `--all`.

Requires:

- A locally installed Chrome/Chromium.
- All `LLM_*` models that the individual subcommands need (sourcing/listing/scripting/viewing/evaluate).

## `reset`

Requeue the tasks in one pipeline stage so the next run reprocesses them. `reset` writes fresh `queued` rows and does not process anything itself, so follow it with `jobfinder start-pipeline` (or the stage's own `--start`) to drain the queue. The stage argument is one of `sourcing`, `listing`, `scripting`, `run-scripts`, `viewing`, `evaluate` (`seeding` is excluded because it generates new seeds rather than re-picking existing rows).

Pick exactly one selector:

```bash
# Requeue every in-scope entity for the stage, including ones already done
# (equivalent to the stage's own --all). Use after a prompt or config change.
jobfinder reset viewing --all

# Requeue only entities whose latest state produced no result
# (e.g. not_a_job_posting, no_source_found, no_listing_found, no_result_found).
jobfinder reset viewing --no-result

# Requeue only entities whose latest state is an error (failed, script_error, aborted).
jobfinder reset run-scripts --failed
```

Unlike `--all`, the `--no-result` and `--failed` selectors key off each entity's current (latest) pipeline state, so they touch only the rows that actually reached one of those states.

## `export jobs`

Dump fully-evaluated JobPost rows (status=`Done`) to a CSV file — i.e. posts in an active source tree, above the title-relevancy threshold, with viewing + evaluate already populated. Useful for ad-hoc analysis in a spreadsheet / pandas.

```bash
# Default output: ./jobs.out.csv (matches the *.out.* gitignore)
jobfinder export jobs

# Custom path + sort by skill × interest (ignore location)
jobfinder export jobs ./shortlist.csv --sort 'excl. location'
```

Sort keys mirror `jobfinder tui`'s `--sort`: `all`, `interest`, `skill`, `location`, `excl. interest`, `excl. location`. If the output file already exists the command prompts before overwriting (`y` / `N`).

## `tui`

Open the live dashboard: the pipeline funnel, the JobPost / Sources tables, and a recent-activity feed, all refreshing as the pipeline writes to the DB. Every flag is deep-link state, so you can jump straight to a specific view.

```bash
# Live dashboard on the Jobs tab
jobfinder tui

# Jump to the Sources tab, sorted by post count
jobfinder tui --tab sources --sources-sort posts

# Harness mode: open the live dashboard AND expose an HTTP control server, so an
# agent (or you) can read the screen and drive it with keystrokes
jobfinder tui --harness
jobfinder tui --harness --harness-port 5599
```

`--harness` opens the normal live dashboard in your terminal **and** attaches a small HTTP control server (its base URL is printed to stderr on startup) so an agent can observe and drive the very same instance you are watching. Your keyboard and injected keystrokes both flow into it, and every change is reflected on your screen and readable over HTTP. (If stdout is not a terminal — piped output, CI, a pure headless agent — it runs the same server without drawing anything.)

While the harness is running it publishes its connection info to `/tmp/jobfinder/harness.<pid>.json` (`url`, `port`, `pid`, and the `screen` / `keys` endpoint URLs) and removes the file on exit, so an agent can discover a running instance without being told the port. The file is keyed by process id, so several TUIs can run at once without clobbering each other; each one also shows its `pid` in the top-right corner of its screen, and a starting instance sweeps discovery files left by processes that have since died.

- `GET /screen` returns a plain-text (ANSI-stripped) snapshot of the current frame.
- `POST /keys` injects keystrokes and returns the resulting frame. The JSON body accepts `keys` (an array of key tokens) and/or `text` (a literal string typed one character at a time), plus an optional `settle` in milliseconds to wait for the re-render. Keys in one request are applied in sequence, with a re-render between each, so a batch behaves like real successive presses. Key tokens are either named keys (`up`, `down`, `left`, `right`, `enter`, `escape`, `tab`, `pageup`, `pagedown`, `home`, `end`, `backspace`, `delete`, `space`, `ctrl+c`) or literal characters (`q`, `s`, `o`, …). `GET /` lists the available key names.

```bash
# Read the current screen
curl -s http://127.0.0.1:5599/screen

# Move the cursor down twice and open the highlighted row
curl -s http://127.0.0.1:5599/keys -d '{"keys":["down","down","enter"]}'

# Switch to the Sources tab and cycle its sort
curl -s http://127.0.0.1:5599/keys -d '{"keys":["tab","s"]}'
```

Sending `q` (or `escape` from the top-level view) quits the TUI, which shuts the server down and ends the process.

## `help-menu-dump`

Dump the full command tree (commands, subcommands, options, choices, defaults) as JSON. Useful for tooling that needs a machine-readable view of the CLI surface.

```bash
# Print to stdout
./src/cli/bin/cli help-menu-dump

# Write canonical dump file
./src/cli/bin/cli help-menu-dump -o __generated__/cli/help-menu.json

# Compact (single-line) JSON
./src/cli/bin/cli help-menu-dump --no-pretty
```

## `completion`

Generate the Zsh completion script and write it to `__generated__/cli/_completion.zsh`.

```bash
# One-off for current shell
source <(./src/cli/bin/cli completion)

# Persistent — add to ~/.zshrc
echo 'source ~/lab/job-finder/__generated__/cli/_completion.zsh' >> ~/.zshrc
```

Regenerate after adding or changing any command/flag — never hand-edit `_completion.zsh`.
