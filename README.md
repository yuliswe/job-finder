# job-finder

`jobfinder` is a command-line tool that finds jobs worth applying to. You describe what you want in plain language, and LLMs driving a real browser discover hiring companies, find their careers pages, collect matching postings, and score each one against your interests and CV. You review the results in a terminal dashboard, where you can also generate tailored résumés and auto-fill application forms.

## Setup (macOS)

1. Add `[ -f ./.zshrc ] && [ $(pwd) != ~ ] && source ./.zshrc` to `~/.zshrc`, run `./initenv.bash` once, and open a new terminal.
2. Run `npm run build` and `npx patchright install chromium`.
3. Set your API keys and models in `jobfinder.config.js`. Example configs are in `examples/`.
4. Write `data/interests.local.md` and `data/cv.local.md`, then run `jobfinder init`.

## Usage

```bash
jobfinder pipeline explore-hiring-companies   # find companies from your interests
jobfinder pipeline approve-seeds              # start tracking them
jobfinder start-pipeline                      # run every stage until done
jobfinder tui                                 # review the results
```

Run `jobfinder --help` to see the other commands.
