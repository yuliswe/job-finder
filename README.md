# job-finder

`jobfinder` is a command-line tool that finds jobs worth applying to, starting from a plain-language description of what you want. It discovers hiring companies, finds each company's careers page, learns how to search it, collects the matching postings, and scores each one against your interests and CV. Results go into a local SQLite database, which you browse in a live terminal dashboard where you can also generate tailored résumés and auto-fill application forms.

The work is done by LLMs driving a real browser. Models can come from OpenRouter, Anthropic, a local Ollama daemon, or the Claude Code CLI.

## Pipeline

Each stage feeds the next one:

1. `explore-hiring-companies` turns your interests into a job search and collects hiring companies, which `approve-seeds` then promotes to tracked companies.
2. `research-company` finds each company's website.
3. `identify-job-list-url` crawls the site to find its job-listing page.
4. `learn-to-use-job-list` has the LLM write and test a script that searches that page.
5. `apply-filters` runs the script with your division and location and saves the postings it finds.
6. `view-job-detail` extracts each posting's details, such as title, location, salary, and description.
7. `evaluate-skill-match` scores each posting for interest, skill, and location fit.

## Setup (macOS)

1. Add the following to `~/.zshrc` so that entering the repo activates its environment, then run `./initenv.bash` once and open a new terminal.

   ```zsh
   if [ -f ./.zshrc ] && [ $(pwd) != ~ ]; then
     source ./.zshrc
   fi
   ```

2. Build the CLI with `npm run build` (or keep `npm start` running to rebuild on change), and install a browser with `npx patchright install chromium`.
3. Edit `jobfinder.config.js` to set your API keys and choose a model for each stage. Ready-made configs for each provider are in `examples/`.
4. Write your inputs in `data/`. The `*.local.md` versions are gitignored and take precedence over the plain files.
   - `interests.local.md` describes the roles, companies, and locations you want.
   - `cv.local.md` is your CV.
   - `profile.local.md` holds the answers used to fill application forms.
5. Create the database with `jobfinder init`.

## Usage

```bash
jobfinder pipeline explore-hiring-companies   # find companies from interests.md
jobfinder pipeline approve-seeds              # start tracking them
jobfinder start-pipeline                      # run every stage until all queues drain
jobfinder tui                                 # watch progress and review jobs
```

You can add one company or posting directly with `jobfinder track <url>`.

Each stage can also be run on its own with `jobfinder pipeline <stage>`. By default a stage command only queues work for the next `start-pipeline`, and `--start` processes it immediately. Use `--include-failed` to retry failures, or `--all` to redo everything after changing a prompt or model.

Other useful commands:

```bash
jobfinder reset <stage> --failed       # requeue a stage's failed rows
jobfinder job bump <id>                # process one posting ahead of the rest
jobfinder job exclude <id-or-url>      # hide a posting and skip it in the pipeline
jobfinder fill-form <id-or-url>        # auto-fill an application form (never submits)
jobfinder export jobs                  # write evaluated postings to jobs.out.csv
```

Run `jobfinder <command> --help` for all options. In the dashboard, the footer lists the keys. On a job's detail screen, `p` generates a tailored résumé PDF and `x` excludes the job. `jobfinder tui --harness` also exposes the dashboard over HTTP so that a script or agent can drive it.

## Development

- `npm test` runs the tests.
- `npm run db:migrate` applies migrations, and `npm run db:migrate:create` creates a new one.
- After changing a command or flag, run `jobfinder completion` and `jobfinder help-menu-dump` to regenerate the files in `__generated__/`.
