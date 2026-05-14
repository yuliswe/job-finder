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

## `completion`

Generate the Zsh completion script and write it to `src/cli/_completion.zsh`.

```bash
# One-off for current shell
source <(./src/cli/bin/cli completion zsh)

# Persistent — add to ~/.zshrc
echo 'source ~/lab/job-finder/src/cli/_completion.zsh' >> ~/.zshrc
```

Regenerate after adding or changing any command/flag — never hand-edit `_completion.zsh`.
