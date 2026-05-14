---
name: validate-your-code
description: Validate the code you just changed by running tsc --noEmit, eslint, and prettier -w on the touched files.
allowed-tools: [Bash, Read, Edit, Grep, Glob]
---

# Validate Your Code

Run the project's standard validation toolchain on the files you changed in this turn, and fix anything that fails before reporting back.

## Instructions

1. Identify the files you changed (the ones you wrote or edited in this conversation — not every file in the repo).
2. Run each of the three checks below. If any fail, fix the underlying code and re-run that check until it passes. Don't suppress errors with `--no-verify`, `eslint-disable-line`, or `// @ts-ignore` unless the user has explicitly asked for it.

## Checks

Run all three. Order matters: prettier formats first so eslint/tsc see the final layout.

```bash
# 1. Format the changed files in place.
npx prettier -w <changed files>

# 2. Lint the changed files.
npx eslint <changed files>

# 3. Typecheck the whole project (tsc has no per-file mode for project-wide type resolution).
npx tsc --noEmit
```
