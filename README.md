# job-finder

`jobfinder` is a command-line tool that finds jobs worth applying to. You describe what you want in plain language, and LLMs driving a real browser do the searching. Results are stored in a local SQLite database, and you review them in a terminal dashboard where you can also generate tailored résumés and auto-fill application forms.

## How it works

The pipeline runs these stages in order, and each one feeds the next:

1. **explore-hiring-companies** turns your interests into a job search and collects the companies that are hiring.
2. **research-company** finds each company's website.
3. **identify-job-list-url** crawls the site to find its careers page.
4. **learn-to-use-job-list** has the LLM write and test a script that searches that page.
5. **apply-filters** runs the script with your division and location and saves the postings it finds.
6. **view-job-detail** extracts each posting's title, location, salary, and description.
7. **evaluate-skill-match** scores each posting for interest, skill, and location fit.

## Setup (macOS)

1. Add `[ -f ./.zshrc ] && [ $(pwd) != ~ ] && source ./.zshrc` to `~/.zshrc`, run `./initenv.bash` once, and open a new terminal.
2. Run `npm run build` and `npx patchright install chromium`.
3. Set your API keys and a model for each stage in `jobfinder.config.js`. Models can come from OpenRouter, Anthropic, Ollama, or the Claude Code CLI, and `examples/` has a ready-made config for each.
4. Describe what you are looking for in `data/interests.local.md` and paste your CV into `data/cv.local.md`. Add `data/profile.local.md` if you want to auto-fill application forms.
5. Run `jobfinder init` to create the database.

## Usage

```bash
jobfinder pipeline explore-hiring-companies   # find companies from your interests
jobfinder pipeline approve-seeds              # start tracking them
jobfinder start-pipeline                      # run every stage until all queues drain
jobfinder tui                                 # review the results
```

To add a single company or posting, run `jobfinder track <url>`.

You can also run one stage at a time with `jobfinder pipeline <stage>`. By default this only queues work for the next `start-pipeline`, and `--start` processes it right away. Add `--include-failed` to retry failures, or `--all` to redo everything after changing a prompt or model.

A few other commands are handy:

```bash
jobfinder job bump <id>             # process one posting ahead of the rest
jobfinder job exclude <id-or-url>   # hide a posting and skip it in the pipeline
jobfinder fill-form <id-or-url>     # auto-fill an application form (never submits)
jobfinder export jobs               # write evaluated postings to jobs.out.csv
```

Run `jobfinder --help` for everything else.
