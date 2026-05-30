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

## `scrape`

Scrape jobs from one or more sites.

```bash
# Quickstart: 30 software-engineer jobs from Indeed in Waterloo
./src/cli/bin/cli scrape -q "software engineer" -l "Waterloo, Ontario" -n 30 --country canada

# Multi-site with recency filter, write CSV
./src/cli/bin/cli scrape \
  -s linkedin indeed glassdoor \
  -q "AI engineer" \
  --hours-old 72 \
  --linkedin-fetch-description \
  -f csv -o jobs.csv

# Google search (requires the full natural-language query)
./src/cli/bin/cli scrape \
  -s google \
  --google-search "AI engineer jobs near San Francisco posted yesterday"

# Remote-only, internship
./src/cli/bin/cli scrape -q "ML" --remote --job-type internship -n 50
```

See `./src/cli/bin/cli scrape --help` for the full flag list.

## `sites`

Print the supported sites and job types (useful as a reference for `--site` / `--job-type`).

```bash
./src/cli/bin/cli sites
```

## `pipeline listing`

For each unprocessed `JobSource`, open the company URL and BFS the same-domain links the LLM ranks most likely to lead to a careers/jobs page (capped at `PIPELINE_LISTING_BFS_MAX_DEPTH`). The first page the LLM classifies as a listing page is inserted as a new `JobListSource` row with an empty `parserScript` placeholder. `pipeline scripting` fills the script in later. The `JobSource` is always marked `isProcessed` after the attempt to avoid re-running BFS.

```bash
./src/cli/bin/cli pipeline listing
```

Requires:

- A locally installed Chrome/Chromium (run `npx patchright install chromium` once if not).
- `LLM_LISTING_MODEL` set in `jobfinder.config.js`.

## `pipeline scripting`

For each unprocessed `JobListSource` (i.e. one whose `parserScript` has not yet been generated), reload the listing page and ask the LLM to emit a JavaScript snippet defining `listLocations()` and `async searchJobs(locations, keywords)`. The script is executed inside the page in a feedback loop — corrective feedback is fed back to the LLM until `searchJobs` returns a non-empty `{ jobTitle, url }[]`. On success, the script is stored in `JobListSource.parserScript` and the row is marked `isProcessed`. On failure, the row is left unprocessed so it can be retried (after tweaking prompts, raising `PIPELINE_LISTING_BFS_MAX_DEPTH`, etc.).

```bash
./src/cli/bin/cli pipeline scripting
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_LISTING_MODEL` set in `jobfinder.config.js`.

## `pipeline run-scripts`

For every `JobListSource` with a validated `parserScript`, reload the listing page, call the script's `listLocations()` and `listDivisions()` to enumerate the page's actual filter values, ask the LLM to map the user-supplied `--division` and `--location` strings to subsets of those values, then invoke `searchJobs()` with the picks and insert every returned `{ jobTitle, url }` into `JobPost` (ON CONFLICT(url) DO NOTHING). Each row is recorded in `PipelineState` with `task='run-scripts'` and state `script_error` / `no_result_found` / `success`.

```bash
./src/cli/bin/cli pipeline run-scripts -d engineering -l "Toronto, ON"
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_LISTING_MODEL` set in `jobfinder.config.js`.

## `pipeline viewing`

For each unprocessed `JobPost` (i.e. `isProcessed=false`), open the posting URL, clean the page HTML, and ask the LLM to extract structured fields (`title`, `company`, `location`, `description`, `isRemote`, `jobType`, `postedAt`, `salaryMin`/`salaryMax`/`salaryCurrency`/`salaryInterval`, `summary`). The row is updated with whatever fields the LLM populates and marked `isProcessed`. Each row is recorded in `PipelineState` with `task='viewing'` and state `done` / `failed`.

```bash
jobfinder pipeline viewing
```

Pass `--all` to re-view every qualifying `JobPost` regardless of pipeline state — including ones already `done` / `not_a_job_posting` / `failed`. Useful after a prompt change.

```bash
jobfinder pipeline viewing --all
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_VIEWING_MODEL` set in `jobfinder.config.js`.

## `pipeline sourcing`

For each distinct `name` in `SourceSeed`, take the top 3 most recent rows (by `createdAt`), open each URL with headless Puppeteer, and ask the LLM to identify the hiring company. Insert each discovered company (hostname-normalized URL, unique) into `JobSource`.

```bash
jobfinder pipeline sourcing
```

All pipeline subcommands (except `seeding`) accept `--all` to re-process every qualifying parent regardless of pipeline state — including ones already `done` / `failed` / `aborted`. Useful after a prompt change. Available on `sourcing`, `listing`, `scripting`, `run-scripts`, `viewing`, `evaluate`:

```bash
jobfinder pipeline sourcing --all
jobfinder pipeline evaluate --all
```

Each of those subcommands also accepts a `--<parent-table>-id <id>` flag to force-process a single record regardless of pipeline state or qualification (the record is re-queued before the task runs):

- `sourcing --source-seed-id <id>`
- `listing --job-source-id <id>`
- `scripting --job-list-source-id <id>`
- `run-scripts --job-list-source-id <id>`
- `viewing --job-post-id <id>`
- `evaluate --job-post-id <id>`

```bash
jobfinder pipeline viewing --job-post-id 0192...abcd
jobfinder pipeline run-scripts --job-list-source-id 0192...abcd
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

## `run-pipeline`

Run sourcing, listing, scripting, run-scripts, viewing, and evaluate concurrently in independent loops until every queue drains. Each loop re-iterates immediately when its previous iteration processed ≥1 row, and sleeps 5s only when it found nothing to do. The orchestrator exits once every task has finished an idle iteration with no productive work happening anywhere in between — so it's the right thing to leave running unattended after `pipeline seeding` + `pipeline approve-seeds`.

```bash
jobfinder run-pipeline
```

Each browser-using task (sourcing, listing, scripting, run-scripts, viewing) holds its own long-lived Chromium instance for the loop's lifetime — no per-poll cold starts. Per-row failures (`PIPELINE_STATE.FAILED`/`ABORTED`/etc.) stay failed; retry them later with the relevant subcommand and `--include-failed` or `--all`.

Requires:

- A locally installed Chrome/Chromium.
- All `LLM_*` models that the individual subcommands need (sourcing/listing/scripting/viewing/evaluate).

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

## `completion-script-dump`

Generate the Zsh completion script and write it to `__generated__/cli/_completion.zsh`.

```bash
# One-off for current shell
source <(./src/cli/bin/cli completion-script-dump)

# Persistent — add to ~/.zshrc
echo 'source ~/lab/job-finder/__generated__/cli/_completion.zsh' >> ~/.zshrc
```

Regenerate after adding or changing any command/flag — never hand-edit `_completion.zsh`.
