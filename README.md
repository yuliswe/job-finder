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

For each unprocessed `JobSource`, open the company URL and BFS the same-domain links the LLM ranks most likely to lead to a careers/jobs page (capped at `PIPELINE_IDENTIFY_JOB_LIST_URL_BFS_MAX_DEPTH`). The first page the LLM classifies as a listing page is inserted as a new `JobListSource` row with an empty `parserScript` placeholder. `pipeline learn-to-use-job-list` fills the script in later. The `JobSource` is always marked `isProcessed` after the attempt to avoid re-running BFS.

```bash
./src/cli/bin/cli pipeline listing --start
```

Requires:

- A locally installed Chrome/Chromium (run `npx patchright install chromium` once if not).
- `LLM_IDENTIFY_JOB_LIST_URL_MODEL` set in `jobfinder.config.js`.

## `pipeline learn-to-use-job-list`

For each unprocessed `JobListSource` (i.e. one whose `parserScript` has not yet been generated), reload the listing page and ask the LLM to emit a JavaScript snippet defining `listLocations()` and `async searchJobs(locations, keywords)`. The script is executed inside the page in a feedback loop — corrective feedback is fed back to the LLM until `searchJobs` returns a non-empty `{ jobTitle, url }[]`. On success, the script is stored in `JobListSource.parserScript` and the row is marked `isProcessed`. On failure, the row is left unprocessed so it can be retried (after tweaking prompts, raising `PIPELINE_IDENTIFY_JOB_LIST_URL_BFS_MAX_DEPTH`, etc.).

```bash
./src/cli/bin/cli pipeline learn-to-use-job-list --start
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_IDENTIFY_JOB_LIST_URL_MODEL` set in `jobfinder.config.js`.

## `pipeline apply-filters`

For every `JobListSource` with a validated `parserScript`, reload the listing page, call the script's `listLocations()` and `listDivisions()` to enumerate the page's actual filter values, ask the LLM to map the user-supplied `--division` and `--location` strings to subsets of those values, then invoke `searchJobs()` with the picks and insert every returned `{ jobTitle, url }` into `JobPost` (ON CONFLICT(url) DO NOTHING). Each row is recorded in `PipelineState` with `task='apply-filters'` and state `script_error` / `no_result_found` / `success`.

```bash
./src/cli/bin/cli pipeline apply-filters -d engineering -l "Toronto, ON" --start
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_IDENTIFY_JOB_LIST_URL_MODEL` set in `jobfinder.config.js`.

## `pipeline view-job-detail`

For each unprocessed `JobPost` (i.e. `isProcessed=false`), open the posting URL, clean the page HTML, and ask the LLM to extract structured fields (`title`, `company`, `location`, `description`, `isRemote`, `jobType`, `postedAt`, `salaryMin`/`salaryMax`/`salaryCurrency`/`salaryInterval`, `summary`). The row is updated with whatever fields the LLM populates and marked `isProcessed`. Each row is recorded in `PipelineState` with `task='view-job-detail'` and state `done` / `failed`.

```bash
jobfinder pipeline view-job-detail --start
```

Pass `--all` to re-queue every qualifying `JobPost` regardless of pipeline state — including ones already `done` / `not_a_job_posting` / `failed`. Useful after a prompt change.

```bash
jobfinder pipeline view-job-detail --all --start
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_VIEW_JOB_DETAIL_MODEL` set in `jobfinder.config.js`.

## `pipeline research-company`

For each distinct `name` in `SourceSeed`, take the top 3 most recent rows (by `createdAt`), open each URL with headless Puppeteer, and ask the LLM to identify the hiring company. Insert each discovered company (hostname-normalized URL, unique) into `JobSource`.

```bash
jobfinder pipeline research-company --start
```

By default, `research-company`, `listing`, `learn-to-use-job-list`, `apply-filters`, `view-job-detail`, and `evaluate` only queue the rows they select — nothing is processed until you either pass `--start` or let `jobfinder start-pipeline` drain the queues. This makes it cheap to stage work first and process it later in one orchestrated run:

```bash
# Queue failed view-job-detail rows now, process everything queued later:
jobfinder pipeline view-job-detail --include-failed
jobfinder start-pipeline

# Or queue and process in one invocation:
jobfinder pipeline view-job-detail --include-failed --start
```

All pipeline subcommands (except `explore-hiring-companies`) accept `--all` to re-queue every qualifying parent regardless of pipeline state — including ones already `done` / `failed` / `aborted`. Useful after a prompt change. Available on `research-company`, `listing`, `learn-to-use-job-list`, `apply-filters`, `view-job-detail`, `evaluate`:

```bash
jobfinder pipeline research-company --all --start
jobfinder pipeline evaluate --all --start
```

Each of those subcommands also accepts a `--<parent-table>-id <id>` flag to force a single record onto the queue regardless of pipeline state or qualification (add `--start` to process it immediately):

- `research-company --source-seed-id <id>`
- `listing --job-source-id <id>`
- `learn-to-use-job-list --job-list-source-id <id>`
- `apply-filters --job-list-source-id <id>`
- `view-job-detail --job-post-id <id>`
- `evaluate --job-post-id <id>`

```bash
jobfinder pipeline view-job-detail --job-post-id 0192...abcd --start
jobfinder pipeline apply-filters --job-list-source-id 0192...abcd --start
```

Requires:

- A locally installed Chrome/Chromium (run `npx puppeteer browsers install chrome` once if not).
- `LLM_RESEARCH_COMPANY_MODEL` set in `jobfinder.config.js`.

## `pipeline explore-hiring-companies`

Read `data/interests.md`, ask the LLM to translate the interests into a `python-jobspy` call, run the call in a feedback loop (the LLM gets a chance to fix failures), then insert each unique result into the `SourceSeed` table.

```bash
./src/cli/bin/cli pipeline explore-hiring-companies
```

Requires:

- `OPENROUTER_API_KEY` set in the environment.
- `LLM_EXPLORE_HIRING_COMPANIES_MODEL` set in `src/llm/config.ts` (empty by default).
- `data/interests.md` populated with the user's job-search interests.

## `start-pipeline`

Run research-company, listing, learn-to-use-job-list, apply-filters, view-job-detail, and evaluate concurrently in independent loops until every queue drains. Each loop re-iterates immediately when its previous iteration processed ≥1 row, and sleeps 5s only when it found nothing to do. The orchestrator exits once every task has finished an idle iteration with no productive work happening anywhere in between — so it's the right thing to leave running unattended after `pipeline explore-hiring-companies` + `pipeline approve-seeds`.

```bash
jobfinder start-pipeline

# Also retry every in-scope row whose latest state is NOT done
# (failed / aborted / no_result / etc.) — applied once on each task's
# first iteration via the same picker semantics as
# `jobfinder pipeline <task> --include-failed`. Subsequent iterations
# run in default queued-only mode so a transient failure inside the
# run is not retried forever.
jobfinder start-pipeline --include-failed

# Override the single-instance lock (below). Only when you are certain the
# recorded holder process is actually dead.
jobfinder start-pipeline --force
```

Each browser-using task (research-company, listing, learn-to-use-job-list, apply-filters, view-job-detail) holds its own long-lived Chromium instance for the loop's lifetime — no per-poll cold starts. Per-row failures (`PIPELINE_STATE.FAILED`/`ABORTED`/etc.) stay failed; retry them with `--include-failed` on a fresh `start-pipeline`, or with the relevant subcommand and `--include-failed` / `--all`.

Only one `start-pipeline` may run per database at a time. On startup it takes an exclusive lock at `<db-path>.pipeline.lock`; a second instance against the same database refuses to start and exits non-zero, because concurrent runs would double-process every queued row and each run's stale-`started` reap would requeue the other's legitimately in-flight rows as if they were crash orphans. The lock records the holder's PID and is released on normal exit and on Ctrl+C / `SIGTERM`. A run killed with `SIGKILL` (or a power loss) leaves the file behind, but the next start detects the dead PID and reclaims it automatically, so a stale lock never needs manual cleanup; `--force` is only for the rare case where you want to override a lock whose holder you have already confirmed is dead. Two pipelines pointed at _different_ databases run independently and never block each other.

Requires:

- A locally installed Chrome/Chromium.
- All `LLM_*` models that the individual subcommands need (research-company/listing/learn-to-use-job-list/view-job-detail/evaluate).

## `reset`

Requeue the tasks in one pipeline stage so the next run reprocesses them. `reset` writes fresh `queued` rows and does not process anything itself, so follow it with `jobfinder start-pipeline` (or the stage's own `--start`) to drain the queue. The stage argument is one of `research-company`, `listing`, `learn-to-use-job-list`, `apply-filters`, `view-job-detail`, `evaluate` (`explore-hiring-companies` is excluded because it generates new seeds rather than re-picking existing rows).

Pick exactly one selector:

```bash
# Requeue every in-scope entity for the stage, including ones already done
# (equivalent to the stage's own --all). Use after a prompt or config change.
jobfinder reset view-job-detail --all

# Requeue only entities whose latest state produced no result
# (e.g. not_a_job_posting, no_source_found, no_listing_found, no_result_found).
jobfinder reset view-job-detail --no-result

# Requeue only entities whose latest state is an error (failed, script_error, aborted).
jobfinder reset apply-filters --failed
```

Unlike `--all`, the `--no-result` and `--failed` selectors key off each entity's current (latest) pipeline state, so they touch only the rows that actually reached one of those states.

## `job bump`

Manually prioritize a single JobPost so it clears the `view-job-detail` and `evaluate` stages ahead of the rest of the backlog. The two pickers order their eligible rows by the bump timestamp (most recently bumped first, unbumped last), so under contention a bumped post lands in the first concurrency batch and flows through both stages before its peers.

```bash
# Prioritize one post — it will be fetched and evaluated ahead of the others
jobfinder job bump 0192...abcd

# Bump a second post: because ordering is by recency, it now outranks the first
jobfinder job bump 0192...ef01

# Remove the bump
jobfinder job bump 0192...abcd --clear
```

Bumps are cumulative and persist until you clear them or the post finishes evaluating and drops out of the pickers. In the TUI, press `b` on a highlighted job to toggle its bump; bumped rows show a yellow `▲` in the `pri` column.

## `export jobs`

Dump fully-evaluated JobPost rows (status=`Done`) to a CSV file — i.e. posts in an active source tree, above the title-relevancy threshold, with view-job-detail + evaluate already populated. Useful for ad-hoc analysis in a spreadsheet / pandas.

```bash
# Default output: ./jobs.out.csv (matches the *.out.* gitignore)
jobfinder export jobs

# Custom path + sort by skill × interest (ignore location)
jobfinder export jobs ./shortlist.csv --sort 'excl. location'
```

The sort keys are `all`, `interest`, `skill`, `location`, `excl. interest`, `excl. location`. If the output file already exists the command prompts before overwriting (`y` / `N`).

## `job exclude` / `job include`

Manually override a single post's scope. Scope is otherwise derived entirely from active-tree membership and the LLM relevancy scores; `job exclude` is the one signal a human controls directly. Excluding a post pushes it out of scope for the view-job-detail and evaluate stages (so `start-pipeline` and the stage pickers skip it) and hides it from the TUI's default `in` filter, exactly as a below-threshold relevancy score would. `job include` reverses it, after which the usual active-tree and relevancy gates apply again. A post is identified by its `JobPost.id` or its `url`.

```bash
# Exclude by url, recording why
jobfinder job exclude https://acme.example/jobs/123 --reason 'duplicate posting'

# Exclude by id
jobfinder job exclude 019f97e6-5c19-7658-9b61-5524a71c5485

# Undo the exclusion
jobfinder job include https://acme.example/jobs/123
```

An excluded post stays out of scope even across a `pipeline evaluate --all` requeue — a manual exclusion outranks a bulk requeue — so `job include` (or the TUI's `x` key) is the only way back into scope. The same toggle is available in the TUI: press `x` on a post's detail screen.

## `tui`

Open the live dashboard: the pipeline funnel, the JobPost / Sources tables, and a recent-activity feed, all refreshing as the pipeline writes to the DB. The dashboard opens on the Jobs tab; switch tabs and re-sort from inside the TUI.

```bash
# Live dashboard
jobfinder tui

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
