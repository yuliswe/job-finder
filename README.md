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
- `LLM_LISTING_MODEL` set in `jobfinder.config.ts`.

## `pipeline scripting`

For each unprocessed `JobListSource` (i.e. one whose `parserScript` has not yet been generated), reload the listing page and ask the LLM to emit a JavaScript snippet defining `listLocations()` and `async searchJobs(locations, keywords)`. The script is executed inside the page in a feedback loop — corrective feedback is fed back to the LLM until `searchJobs` returns a non-empty `{ jobTitle, url }[]`. On success, the script is stored in `JobListSource.parserScript` and the row is marked `isProcessed`. On failure, the row is left unprocessed so it can be retried (after tweaking prompts, raising `PIPELINE_LISTING_BFS_MAX_DEPTH`, etc.).

```bash
./src/cli/bin/cli pipeline scripting
```

Requires:

- A locally installed Chrome/Chromium.
- `LLM_LISTING_MODEL` set in `jobfinder.config.ts`.

## `pipeline sourcing`

For each distinct `name` in `SourceSeed`, take the top 3 most recent rows (by `createdAt`), open each URL with headless Puppeteer, and ask the LLM to identify the hiring company. Insert each discovered company (hostname-normalized URL, unique) into `JobSource`.

```bash
./src/cli/bin/cli pipeline sourcing
```

Requires:

- A locally installed Chrome/Chromium (run `npx puppeteer browsers install chrome` once if not).
- `LLM_SOURCING_MODEL` set in `jobfinder.config.ts`.

## `pipeline seeding`

Read `seeds/interests.md`, ask the LLM to translate the interests into a `python-jobspy` call, run the call in a feedback loop (the LLM gets a chance to fix failures), then insert each unique result into the `SourceSeed` table.

```bash
./src/cli/bin/cli pipeline seeding
```

Requires:

- `OPENROUTER_API_KEY` set in the environment.
- `LLM_SEEDING_MODEL` set in `src/llm/config.ts` (empty by default).
- `seeds/interests.md` populated with the user's job-search interests.

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
