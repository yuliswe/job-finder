---
name: write-cli-commands
description: Checklist for implementing or modifying a CLI subcommand's interface under src/cli.
---

# Write CLI Commands

When creating a new CLI command for `src/cli/bin/cli`, follow this checklist:

## Command Implementation

- [ ] Create the command file in `src/cli/commands/` (or a subdirectory `src/cli/commands/<group>/` for nested subcommands).
- [ ] Follow the existing pattern: export a `create<Xxx>Command(): Command` factory returning a `commander` `Command`.
- [ ] Use `.addOption(new Option(...).choices([...]))` for any enum-valued option — this is what powers static tab-completion.
- [ ] Register the command in its parent: `src/cli/bin/cli.ts` for top-level commands, or the group's `src/cli/commands/<group>.ts` for nested ones.
- [ ] Factor reusable helpers into `src/cli/utils/`.

## After Writing the Command

- [ ] **Regenerate `__generated__/cli/_completion.zsh`** by running `./src/cli/bin/cli completion-script-dump`. The generator walks the commander tree and inlines every option's `argChoices`, so static enums get tab-completion automatically — DO NOT hand-edit `_completion.zsh`.

- [ ] If the new command takes a dynamic value that can't be expressed as static choices (e.g. needs a DB or network lookup at completion time), extend `src/cli/commands/completion-script-dump.ts`:
  1. Add a helper function (e.g. `_cli_<thing>`) that calls a hidden `cli complete <thing>` subcommand and pipes the lines into `_describe`.
  2. Add a hidden `complete` subcommand (set `_hidden = true`) that prints the values, one per line, to stdout.
  3. Reference the helper in `formatOptionSpec` / `formatArgumentSpec` so the generator emits it for matching option/argument names.
  4. Regenerate `_completion.zsh`.

- [ ] **Update `README.md`** — add at least one usage example for the new command under the CLI section, showing the flags a typical user would reach for first.

- [ ] Run the `/validate-your-code` skill (prettier + eslint + tsc) on the touched files.
