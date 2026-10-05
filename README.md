# job-finder

`jobfinder` is a command-line tool that finds jobs worth applying to, starting from a plain-language description of what you want. It discovers hiring companies, locates each company's own careers page, learns how to search that page, pulls the matching postings, and scores every posting against your interests and your CV. Everything it finds is stored in a local SQLite database and shown in a live terminal dashboard, from which you can review postings, tag them, generate a tailored résumé, and auto-fill application forms.

Most of the work is done by LLMs driving a real browser. Each stage can use a different model, and models can come from OpenRouter, Anthropic, a local Ollama daemon, or the local Claude Code CLI.

## How it works

The pipeline is a chain of stages. Each stage reads rows produced by the stage before it, records its outcome per row in `PipelineState`, and writes new rows for the next stage.

| Stage                      | Reads           | Does                                                                                                                                                    | Writes                       |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `explore-hiring-companies` | `interests.md`  | Translates your interests into a `python-jobspy` search and collects the companies that are hiring.                                                     | `SourceSeed`                 |
| `approve-seeds`            | `SourceSeed`    | Promotes each seed company into a tracked company with no URL yet.                                                                                      | `JobSource`                  |
| `research-company`         | `JobSource`     | Uses web search to find the company's website, then opens the page to verify it.                                                                        | `JobSource.url`              |
| `identify-job-list-url`    | `JobSource`     | Crawls the company site breadth-first, following the links the LLM ranks as most likely to lead to a careers page, until it finds the job-listing page. | `JobListSource`              |
| `learn-to-use-job-list`    | `JobListSource` | Has the LLM write a JavaScript parser (`listLocations`, `searchJobs`) for the listing page and iterates on it with feedback until it returns real jobs. | `JobListSource.parserScript` |
| `apply-filters`            | `JobListSource` | Maps your division and location onto the page's own filter values, runs the parser, and inserts every matching posting.                                 | `JobPost`                    |
| `view-job-detail`          | `JobPost`       | Opens each posting and extracts title, company, location, description, salary, remote status, and a summary.                                            | `JobPost` fields             |
| `evaluate-skill-match`     | `JobPost`       | Scores the posting for interest, skill, and location fit against `interests.md` and `cv.md`.                                                            | `JobPostEval`                |
| `fill-form`                | `JobPost`       | Generates a script that fills the posting's application form from your applicant profile. It never submits, and `start-pipeline` does not run it.       | `JobPost.fillFormScript`     |

Postings whose title or location relevancy falls below the thresholds in `jobfinder.config.js` are dropped from scope, so the later and more expensive stages only spend effort on plausible matches.

## Setup

### 1. Development environment (macOS)

The repo ships its own Python virtualenv and Node environment. Add these lines to `~/.zshrc` so that entering the repo activates them:

```zsh
if [ -f ./.zshrc ] && [ $(pwd) != ~ ]; then
  source ./.zshrc
fi
```

Then run the one-time setup and open a new terminal in the repo:

```bash
./initenv.bash
```

The activated shell puts `jobfinder` on your `PATH` and loads its Zsh completion. The `jobfinder` binary runs the compiled code in `dist/`, so build it once with `npm run build`, or keep `npm start` running to rebuild on every change.

The browser stages need a local Chromium. Run `npx patchright install chromium` once if you do not have one.

### 2. Configuration

All settings live in `jobfinder.config.js` at the repo root. It is plain JavaScript and is read on every run, so edits take effect immediately without a rebuild. To use a different file, set `CONFIG_FILE` to its path. The `examples/` directory contains ready-made configs for each LLM provider (`jobfinder-openrouter.config.js`, `jobfinder-anthropic.config.js`, `jobfinder-ollama.config.js`, and `jobfinder-claudecode.config.js`).

The settings you will most likely touch are these:

- **Credentials.** Set `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, and `SERPER_API_KEY` in the environment or in the config. You only need the keys for the providers your models use.
- **Models.** Each `LLM_*_MODEL` setting is an array of model IDs tried in fallback order. Every ID carries a provider prefix, such as `openrouter-plugin/…`, `anthropic-plugin/…`, `ollama-plugin/…`, or `claudecode-plugin/…`. The comment above each setting lists the capabilities that stage needs.
- **Data location.** `DATA_DIR` (default `./data`) holds your input files and the database file named by `DB_NAME` (default `jobs.db`).
- **Thresholds and limits.** The `PIPELINE_*` settings control crawl depth and the relevancy cutoffs, and the `BROWSER_*` and `MAX_CONCURRENT_BROWSER_TABS` settings control scraping behavior.

### 3. Your data

Put the following files in `DATA_DIR`. For each one, a `*.local.md` copy takes precedence over the plain file and is gitignored, so your real details stay out of version control.

- `interests.local.md` describes the roles, industries, companies, and locations you are looking for. It drives company discovery, the default division and location filters, and the interest score.
- `cv.local.md` is your CV in Markdown, and it drives the skill score.
- `profile.local.md` is your applicant profile (contact details, work authorization, and similar answers), which `fill-form` uses to fill application forms.
- `cv-template.html` is the HTML template used to render tailored résumé PDFs into `RESUME_OUTPUT_DIR`.

### 4. Create the database

```bash
jobfinder init
```

## Typical workflow

```bash
# Discover hiring companies from interests.md, then promote them to tracked companies
jobfinder pipeline explore-hiring-companies
jobfinder pipeline approve-seeds

# Run every stage concurrently until all queues drain
jobfinder start-pipeline

# In another terminal, watch progress and review results
jobfinder tui
```

You can also add a single company or posting by URL. `jobfinder track <url>` asks the LLM whether the URL is a job posting or a careers page and queues the matching stages for it.

```bash
jobfinder track https://acme.example/careers
```

## Running the pipeline

### Queueing and processing

Every stage command (`jobfinder pipeline <stage>`) only queues the rows it selects by default, so you can stage work cheaply and process it later in one run. Pass `--start` to process the queue immediately instead.

```bash
# Queue now, process later along with everything else
jobfinder pipeline view-job-detail --include-failed
jobfinder start-pipeline

# Queue and process in one step
jobfinder pipeline view-job-detail --include-failed --start
```

The stage commands share a common set of selectors:

- With no selector, the command queues rows that have not been processed yet.
- `--include-failed` also retries rows whose last attempt failed, aborted, or found nothing.
- `--all` re-queues every in-scope row regardless of its state, which is what you want after changing a prompt or a model.
- `--job-source-id`, `--job-list-source-id`, or `--job-post-id` (whichever matches the stage) forces a single row onto the queue.

`apply-filters` also accepts `-d/--division` and `-l/--location`, which override the values it would otherwise extract from `interests.md`.

### `start-pipeline`

`start-pipeline` runs `research-company`, `identify-job-list-url`, `learn-to-use-job-list`, `apply-filters`, `view-job-detail`, and `evaluate-skill-match` concurrently, each in its own loop, and exits once every queue is empty. The two downstream stages take priority, which means the upstream stages pause while postings are still waiting to be fetched or scored. As a result, the current backlog is finished before more postings are generated. Each browser stage keeps one long-lived Chromium instance for the whole run.

```bash
jobfinder start-pipeline
jobfinder start-pipeline --include-failed   # retry failed rows once, on each stage's first pass
```

Only one `start-pipeline` can run against a given database at a time, because two runs would process every queued row twice. The run holds a lock at `<db-path>.pipeline.lock`, which it releases on exit or Ctrl+C. If a run is killed hard, the next run notices that the recorded process is dead and reclaims the lock automatically. `--force` overrides a lock whose holder you have already confirmed is dead.

### `reset`

`reset <stage>` re-queues the rows of one stage without processing them. Pick exactly one selector.

```bash
jobfinder reset view-job-detail --all        # every in-scope row, including finished ones
jobfinder reset view-job-detail --no-result  # rows whose last attempt found nothing
jobfinder reset apply-filters --failed       # rows whose last attempt errored
```

## Working with individual jobs

```bash
# Process one posting ahead of the backlog (the most recent bump goes first)
jobfinder job bump <job-post-id>
jobfinder job bump <job-post-id> --clear

# Take a posting out of scope, or put it back
jobfinder job exclude <id-or-url> --reason 'duplicate posting'
jobfinder job include <id-or-url>

# Auto-fill an application form in a visible browser without submitting it
jobfinder fill-form <id-or-url>
```

A manual exclusion survives a bulk `--all` re-queue, so `job include` is the only way to bring the posting back into scope. When `fill-form` receives a URL that is not in the database yet, it creates the posting and queues the stages it needs first. The generated fill script is cached on the posting, and `--regenerate` discards it and generates a new one.

## The dashboard

```bash
jobfinder tui
```

The dashboard shows the pipeline funnel, the Jobs and Sources tables, and a recent-activity feed, all of which refresh as the pipeline writes to the database. The footer lists the key bindings. The most useful ones are listed below.

| Key           | Action                                                              |
| ------------- | ------------------------------------------------------------------- |
| `←` `→` `Tab` | Switch tab                                                          |
| `Enter`       | Open the highlighted job or source                                  |
| `s` / `S`     | Cycle the sort order                                                |
| `o` / `O`     | Show all postings, or only out-of-scope ones                        |
| `t` / `T`     | Tag or untag a job with one of the colors from `TAGS` in the config |
| `b`           | Bump a job's priority                                               |
| `x`           | Exclude or include a job (on the job detail screen)                 |
| `p`           | Generate a tailored résumé PDF (on the job detail screen)           |
| `l`           | Open the URL in your browser                                        |
| `a`           | Toggle whether a source is active (on the Sources tab)              |
| `q` / `Esc`   | Go back or quit                                                     |

### Driving the dashboard from a script or agent

`jobfinder tui --harness` opens the same dashboard and also starts a small HTTP control server, so that a script or an agent can read the screen and press keys on the instance you are watching. The server's URL is printed on startup and published to `/tmp/jobfinder/harness.<pid>.json`. Use `--harness-port` to pin the port.

```bash
jobfinder tui --harness --harness-port 5599

curl -s http://127.0.0.1:5599/screen                                  # current frame as plain text
curl -s http://127.0.0.1:5599/keys -d '{"keys":["down","down","enter"]}'  # press keys, get the new frame
```

The body of `POST /keys` accepts `keys` (named keys such as `up`, `enter`, or `escape`, or single characters), `text` (typed one character at a time), and an optional `settle` delay in milliseconds. `GET /` lists the key names.

## Exporting results

`export jobs` writes every fully evaluated posting to a CSV file for analysis in a spreadsheet or pandas. The `--sort` keys match the dashboard's sort orders (`all`, `interest`, `skill`, `location`, `excl. interest`, and `excl. location`).

```bash
jobfinder export jobs                                  # writes ./jobs.out.csv
jobfinder export jobs ./shortlist.csv --sort 'excl. location'
```

## Development

| Command                       | Purpose                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `npm run build` / `npm start` | Build `dist/` once, or rebuild on every change                                    |
| `npm test`                    | Run the Jest tests                                                                |
| `npm run db:migrate`          | Apply pending migrations                                                          |
| `npm run db:migrate:create`   | Create a new migration                                                            |
| `npm run db:codegen`          | Regenerate the Kysely database types                                              |
| `npm run sql`                 | Open the database in `litecli`                                                    |
| `jobfinder completion`        | Regenerate `__generated__/cli/_completion.zsh` after changing any command or flag |
| `jobfinder help-menu-dump`    | Regenerate `__generated__/cli/help-menu.json`, the machine-readable command tree  |

Never edit the files in `__generated__/` by hand. `jobfinder <command> --help` documents every command and option in full.
