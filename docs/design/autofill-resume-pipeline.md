# Design: resume autofill pipeline

## Summary

This document describes a new, human-triggered pipeline that opens a job
posting's application form in a browser and fills it in from the user's résumé,
stopping short of submitting it. The work is expressed as a new pipeline stage
that generates a browser-side _fill script_ and stores it on the `JobPost` row,
in exactly the way the existing `scripting` stage generates a `parserScript` and
stores it on `JobListSource`. A new top-level command, `jobfinder fill-resume
<jobPostIdOrUrl>`, is the manual entry point. When it is given a URL for a job
post that does not yet exist, it bootstraps the missing entities from the leaf
upward — it creates the `JobPost` first, then a placeholder company
(`JobSource`) as its parent, and then enqueues the enrichment tasks (company
sourcing, post viewing, post evaluation) so that the rest of the content is
backfilled by the normal pipeline while the résumé is being filled in.

The design deliberately reuses the machinery that already exists. The only
genuinely new concepts are one pipeline task (`fill`), one generated-script
column on `JobPost`, a small applicant-profile reader, and the command that ties
the bootstrap and the interactive fill together.

## Goals

- Provide a single manual command that, given a job post ID or a URL, opens the
  application form and fills it from the user's résumé without submitting it.
- Cache the generated fill logic on the job post so re-running is cheap and does
  not require another expensive LLM generation pass.
- When given a URL for a not-yet-known post, create the post and its placeholder
  ancestors and queue the standard enrichment work, so that a manually supplied
  application URL ends up as fully enriched in the database as one discovered by
  the top-down pipeline.
- Never click submit. Filling is a review aid; the human reviews the populated
  form in a visible browser window and submits (or discards) it themselves.

## Non-goals

- Automatic submission of applications. The pipeline stops at a filled form.
- Unattended, bulk résumé filling across the whole backlog. Generation of the
  fill script is cacheable and could run unattended, but the interactive fill is
  driven one post at a time by a human running the command.
- Solving arbitrary anti-bot / captcha / authentication walls. Where a form
  cannot be reached or filled, the stage records a terminal no-result state and
  the human is told why, in the same manner as the existing scraping stages.

## Background: how the existing pipeline works

The concepts below are the substrate this feature builds on. They are described
here so that the rest of the document can refer to them precisely.

### The pipeline is an append-only state log

There is a single linear pipeline whose stages are called _tasks_, declared in
`src/db/pipelineState.ts`:

```
seeding → sourcing → listing → scripting → run-scripts → viewing → evaluate
```

The queue is not a separate object graph; it is the `PipelineState` table used
as an append-only event log. Each row records that a `task` touched an _entity_
and left it in a `state`. Each row carries exactly one of four nullable foreign
keys — `ofSourceSeedId`, `ofJobSourceId`, `ofJobListSourceId`, `ofJobPostId` —
so the queue is keyed by `(task, entity)`. The latest row per `(task, entity)`,
exposed through the `LatestPipelineState` SQL view, is the current status.
Enqueuing a job is simply `enqueuePipelineTask({ task, entity })`, which appends
a `queued` row.

The entity hierarchy that these foreign keys reference is:

```
SourceSeed → JobSource → JobListSource → JobPost   (+ JobPostEval, 1:1 with JobPost)
```

`JobSource` is the company/employer entity; there is no separate `Company`
table. A `JobPost` has a mandatory `ofJobSourceId` (the company) and an optional
`ofJobListSourceId` (the listing page it was scraped from).

### Each stage is a queue-or-run command

Every stage lives in `src/cli/commands/pipeline/<stage>.ts` and exposes the same
shape: a `queueX` function that only appends `queued` rows, and a `runX` function
that opens a browser, picks the queued rows, and processes each one inside
`processOne`, which brackets the work with `started` → `done`/`failed` state
writes. The `runX` functions are imported directly by
`src/cli/commands/start-pipeline.ts`, whose orchestrator runs one independent
concurrent loop per stage until every queue drains. The exported `runX` is
therefore reused both by the single-stage `jobfinder pipeline <stage> --start`
command and by the full-pipeline orchestrator.

### Ordering is data-driven, not a scheduler

Which rows a stage picks up is decided by three predicate families in
`src/db/pipelineQualified.ts`:

- `qualifiedForX` — does the row have the upstream data this task reads (for
  example `run-scripts` requires `parserScript IS NOT NULL`)?
- `inScopeForX` — should the pipeline ever touch this row (active tree
  membership plus design-time skips such as a relevancy threshold)?
- `neededForX` — is there work left, defined only where the task writes a column
  on the parent table.

Cross-entity ordering falls out of these gates automatically: a downstream
stage's `qualifiedForX` requires a column the upstream stage writes, so it
simply does not select the row until the upstream stage has filled it. There is
no explicit "run A before B" scheduler.

Same-entity ordering — the case where a re-queued upstream stage on the _same_
row is about to overwrite a column a downstream stage reads — is handled by
`TASK_PARENTS` in `src/db/pipelineState.ts` together with the
`parentsSettledForPipelineTask` predicate, which blocks a child row while any
same-FK parent task is still pending on that row. Only tasks that share the
child's foreign-key column may appear in `TASK_PARENTS`, and this invariant is
asserted at module load.

### Generated scripts: the `scripting` → `run-scripts` template

The closest analog to résumé autofill already exists. `scripting`
(`src/llm/generateParserScript.ts`) opens a listing page, asks the LLM through
`feedbackLoop` to emit browser-side JavaScript defining `discover()` and
`searchJobs(...)`, validates the candidate by running it inside the live page,
and stores the validated source string in the `JobListSource.parserScript` TEXT
column. `run-scripts` (`src/llm/runParserScript.ts`) later loads that string,
opens the page, and executes it with `new Function(...)` inside
`pageEval`/`page.evaluate` in `src/utils/browser.ts`.

The résumé fill script is the same idea applied to a `JobPost`: generate a
browser-side script that maps the user's profile onto the form's fields, store
it on the post, and execute it against the live form on demand.

### The résumé data already has a home

The user's résumé is `getUserCV()` in `src/utils/userInterests.ts`, which reads
`<DATA_DIR>/cv.local.md` (the gitignored real data) falling back to `cv.md`.
There is already an LLM résumé-tailoring flow, `src/llm/fillCvTemplate.ts`, that
reads `cv.md` plus an HTML template and produces a tailored résumé PDF, wired
into the TUI's `p` shortcut. That flow tailors a document; the new flow types
into a live web form. They share the résumé source but are otherwise separate.

### The `track` command already bootstraps entities

`src/cli/commands/track.ts` is the existing precedent for turning a URL into
entities: it classifies the URL, find-or-creates a `JobSource` by company name,
find-or-creates a `JobPost` by URL (with a placeholder title and a
`JobPostEval` seeded at `titleRelavency = 1.0` so a manually supplied URL
bypasses the viewing relevancy gate), and enqueues `sourcing` on the company and
`viewing` on the post. The new command generalizes this same bottom-up creation
and adds the fill stage.

## The bottom-up bootstrap model

The standard pipeline is top-down: seeding creates `SourceSeed` rows, each stage
enriches its entity and enqueues the next stage on the child it produces, and a
`JobPost` only comes into existence at the far end of the chain, produced by
`run-scripts` from a `JobListSource`.

This feature needs the opposite direction. The human starts from a leaf — a
single application URL — and wants that leaf to become a first-class `JobPost`
with all of its ancestors present and all of its enrichment queued. The insight
that makes this cheap is that the existing gates are entirely data-driven and
`TASK_PARENTS` is same-entity only, so bootstrapping a leaf reduces to three
mechanical steps:

1. Insert the leaf (`JobPost`) so that the fill stage has something to key on.
2. Insert placeholder ancestors (`JobSource`, and where relevant a
   `JobListSource`) so the leaf's mandatory foreign keys are satisfied. A
   placeholder is a row with only its identifying columns filled and its
   enrichment columns left null, exactly as `track` and `listing` already
   create them.
3. Enqueue the relevant `(task, entity)` rows: the leaf's own new task (`fill`)
   plus the ancestors' enrichment tasks (`sourcing` on the company, `viewing` on
   the post; `evaluate` follows automatically because `viewing` enqueues it on
   completion).

No new ordering code is required. Because each enrichment task's own
`qualifiedForX`/`inScopeForX` gate governs when it may run, the placeholders sit
patiently until their prerequisites are met, and the normal `start-pipeline`
loops fill them in. The leaf's `fill` task depends only on the live form and the
user's profile — not on any ancestor column — so it can run first, which is what
the user means by "execute the child first and do the parent later." The fill
stage and the enrichment stages proceed independently.

Concretely, running `fill-resume` on a new URL produces this ordering:

```
create JobPost (leaf)                     ── child first
create placeholder JobSource (parent)     ── parent as placeholder
enqueue fill      on the JobPost          ── the child's own task runs first
enqueue sourcing  on the JobSource        ── parent enrichment, backfilled later
enqueue viewing   on the JobPost          ── leaf-content enrichment
   └ viewing, on completion, enqueues evaluate on the JobPost
```

## New pipeline stage: `fill`

`fill` is a new pipeline task keyed on `ofJobPostId`. It is the direct analog of
`scripting`: its job is to _generate and store_ the fill script, not to perform
the interactive fill. Splitting generation from the interactive fill mirrors the
`scripting` / `run-scripts` split and keeps the expensive, cacheable LLM work
separate from the cheap, human-facing execution.

### What `fill` generates

`fill` opens the job post's application form and asks the LLM, through the same
`feedbackLoop`/`Memory` mechanism `generateParserScript` uses, to emit
browser-side JavaScript defining two functions:

- `async function discoverFields()` — returns the application form's fillable
  fields as a list of `{ label, selector, type, options?, currentValue }`. This
  is the analog of `discover()`; it lets the generator (and the human) see what
  the form asks for. When the job post URL is a description page with an "Apply"
  button rather than the form itself, discovery is also responsible for locating
  and following the apply link to reach the real form, in the same exploratory
  spirit as `generateParserScript`'s `still_exploring` state.
- `async function fillForm(profile)` — given the applicant profile object,
  locates each field and sets its value: typing into text inputs, selecting from
  dropdowns, checking radios and checkboxes, and attaching the résumé file where
  the form has a file input. It returns a report of `{ field, selector,
valueSet, status }` for every field it touched, and it must never activate a
  submit control.

The generation loop validates a candidate script the way `generateParserScript`
does — by executing it in the live page and feeding console output and the
returned field report back to the LLM until the mapping looks right — with one
important divergence noted under Risks: validation may fill inputs, but it must
never submit, so the validation contract forbids clicking submit and treats any
navigation away from the form as a failure.

The validated script string is stored in a new nullable TEXT column,
`JobPost.fillScript`, via `db.updateTable('JobPost').set({ fillScript })`,
exactly as `scripting` writes `JobListSource.parserScript`. On success `fill`
records `done`; when the LLM concludes the form cannot be filled (no form found,
auth wall, captcha) it records an appropriate terminal no-result state and the
column is left null.

### Gates for `fill`

- `qualifiedForFill` — trivially true. Every `JobPost` has a `url` by schema, so
  there is no upstream data prerequisite. (`fill` deliberately does _not_ require
  `viewing` to have run, because the form fields are read from the live page, not
  from the stored `description`.)
- `inScopeForFill` — the post is in an active source tree. Because `fill` is
  triggered explicitly per post by a human, it does not need the title-relevancy
  gate that `viewing` uses; a post the user chose to fill is in scope by virtue
  of being chosen. As with `track`, the bootstrap seeds `JobPostEval` so the post
  is not filtered out elsewhere.
- `TASK_PARENTS` — no entry. `fill` shares the `ofJobPostId` key with `viewing`
  and `evaluate`, but it does not read any column they write, so it must not be
  gated behind them; the three run independently on the same post.

### Whether `fill` runs under `start-pipeline`

Generation of the fill script is safe to run unattended and headless, so `fill`
_could_ be added as a seventh loop in `start-pipeline`. The recommendation is to
**not** add it to the default orchestrator, because generating a fill script for
every post in the backlog is rarely what the user wants and would burn LLM
budget on posts they will never apply to. Instead, `fill` is queued and run on
demand by the `fill-resume` command. The stage is still a first-class pipeline
task (so `jobfinder pipeline fill --job-post-id <id> --start` and `jobfinder
reset fill` work), it is simply not part of the always-on drain loop. This is a
one-line decision in `start-pipeline.ts`'s `TASKS` list and can be revisited.

## The interactive fill

Storing a `fillScript` does not by itself fill anything; it is the cached logic.
The actual fill is performed by a small runner analogous to `runParserScript`,
`src/llm/runFillScript.ts`:

1. Open the application form in a **headed** browser. The command forces a
   headed context regardless of `USE_HEADLESS_BROWSER`, because the entire point
   is for the human to see and review the populated form.
2. Load the user's applicant profile (see below).
3. Execute the stored `fillScript`'s `fillForm(profile)` against the live form
   via `pageEval` + `new Function`, and collect the returned field report.
4. Print a summary of what was filled (field, value set, status) and leave the
   browser window open, positioned on the form, for the human to review and
   submit manually. It never clicks submit.

The runner is invoked by the `fill-resume` command rather than by the
`start-pipeline` orchestrator, because it is inherently interactive.

## Applicant profile: the fill input

`fillForm` needs discrete fields — first and last name, email, phone, location,
LinkedIn and portfolio URLs, work-authorization and sponsorship answers, years
of experience, and so on — that application forms ask for individually. Two
options exist for supplying them:

- **Reuse `cv.md`.** Feed the existing Markdown résumé to the LLM and let it
  extract the discrete fields during generation. This adds no new data file and
  matches the existing `getUserCV()` convention, but prose extraction is less
  reliable for the small, high-stakes fields (exact email, phone, authorization
  answers).
- **Add a structured applicant profile (recommended).** Introduce
  `<DATA_DIR>/profile.local.md` (falling back to `profile.md`), read by a new
  `getApplicantProfile()` in `src/utils/userInterests.ts`, holding the standard
  application fields as labeled key/value pairs. This is authored once and reused
  for every fill, and it makes the high-stakes fields exact.

The recommendation is the structured profile, with `cv.md` still passed
alongside it so the LLM can answer free-text questions ("why do you want to work
here", cover-letter boxes) from the résumé narrative and attach the résumé file.
The profile file follows the existing `*.local.md` gitignore convention so real
personal data is never committed.

## The command: `jobfinder fill-resume <jobPostIdOrUrl>`

A new top-level command registered in `src/cli/cli.ts`, in
`src/cli/commands/fill-resume.ts`. (The name mirrors the existing kebab-case
commands such as `run-scripts` and `start-pipeline`; `autofill` is a reasonable
alternative if preferred.)

Behavior:

1. **Resolve the target.** If the argument matches an existing `JobPost.id`, use
   that post. Otherwise treat the argument as a URL: normalize it, and
   find-or-create the post and its ancestors using the bottom-up bootstrap
   described above. Distinguishing an ID from a URL is a simple shape/existence
   check (a URL contains a scheme or host; an ID is a bare UUIDv7 that exists in
   `JobPost`).
2. **Bootstrap when creating from a URL.** Reuse the `track` logic — classify the
   URL to obtain the company name, upsert the `JobSource`, upsert the `JobPost`
   with a placeholder title and a `titleRelavency = 1.0` eval, and enqueue
   `sourcing` on the company and `viewing` on the post. The `track` helpers
   `upsertJobSourceByName` and `upsertJobPost` are currently private to
   `track.ts` and should be factored into a shared bootstrap module (for example
   `src/db/bootstrapJobPost.ts`) so both commands use one implementation.
3. **Ensure the fill script exists.** If `JobPost.fillScript` is null (or
   `--regenerate` was passed), run the `fill` generation now via the exported
   `runFill(...)` with the single-post selector, so generation happens inline and
   the user sees its progress. If a script is already cached, skip straight to
   the fill.
4. **Perform the interactive fill.** Open the headed browser and run
   `runFillScript(...)`, then leave the window open with a printed summary.

Options:

- `--regenerate` — discard the cached `fillScript` and generate a fresh one
  (the analog of `scripting --job-list-source-id <id>` after a prompt change).
- `--generate-only` — generate and store the fill script without opening the
  interactive fill (useful for pre-warming, and it can run headless).
- `--no-bootstrap` — when given a URL that does not resolve to an existing post,
  fail rather than creating entities. The default is to bootstrap.

Because the completion generator introspects the live commander tree, the new
command and its options are picked up automatically the next time `jobfinder
completion` is run; no completion wiring is required.

## Data model change

A single migration adds the generated-script column to `JobPost`:

- `migrations/<timestamp>_add_job_post_fill_script.ts` — add
  `fillScript TEXT` (nullable) to `JobPost`, mirroring `JobListSource.parserScript`.

No change to `PipelineState` is needed: it already carries an `ofJobPostId`
foreign key, which the new `fill` task reuses. After the migration, regenerate
the Kysely types and schema review with `npm run db:codegen` and `npm run
db:schema-review`, per the `write-db-migrations` skill.

If the structured applicant profile grows beyond a handful of fields, or if the
generation needs to persist the discovered field list for debugging, an adjacent
`fillFieldsDiscovered TEXT` JSON column on `JobPost` (analogous to
`JobListSource.locations`/`divisions`) can be added in the same migration, but it
is optional and not required for the core feature.

## Files to add or change

New files:

- `migrations/<timestamp>_add_job_post_fill_script.ts` — the `JobPost.fillScript`
  column.
- `src/prompts/generateFillScript.ts` — the system prompt defining the fill
  script contract (the `discoverFields()` / `fillForm(profile)` signatures, the
  `new Function` execution environment, the no-submit invariant, and guidance for
  following an apply link and handling common ATS forms such as Greenhouse,
  Lever, Ashby, and Workday). Modeled on `src/prompts/generateParserScript.ts`.
- `src/llm/generateFillScript.ts` — the generation feedback loop returning
  `{ fillScript }`, validated by executing the candidate against the live form.
  Modeled on `src/llm/generateParserScript.ts`.
- `src/llm/runFillScript.ts` — the runtime harness that executes a stored
  `fillScript` against the live form and returns the field report without
  submitting. Modeled on `src/llm/runParserScript.ts`.
- `src/cli/commands/pipeline/fill.ts` — the `fill` stage (`queueFill` / `runFill`),
  modeled on `src/cli/commands/pipeline/scripting.ts`.
- `src/cli/commands/fill-resume.ts` — the top-level manual command.
- `src/db/bootstrapJobPost.ts` — the shared bottom-up bootstrap helpers factored
  out of `track.ts`.
- `src/utils/applicantProfile.ts` (or an addition to `src/utils/userInterests.ts`)
  — `getApplicantProfile()` reading `<DATA_DIR>/profile.local.md`.

Changed files:

- `src/db/pipelineState.ts` — add `'fill'` to the `PipelineTask` union, an entry
  in `FK_BY_TASK` (`fill: 'ofJobPostId'`), a place in `TASK_ORDER`, and a
  `case 'fill'` in `requeueAllInScope`'s switch. No `TASK_PARENTS` entry, and no
  `PARENT_SCOPE_BY_TASK` entry, because `fill` is never a parent of another task.
- `src/db/pipelineQualified.ts` — add `qualifiedForFill` (always true) and
  `inScopeForFill` (active tree).
- `src/cli/commands/pipeline.ts` — register `createFillCommand()`.
- `src/cli/cli.ts` — register `createFillResumeCommand()`.
- `src/cli/commands/reset.ts` — add `'fill'` to `STAGE_CHOICES` so
  `jobfinder reset fill` can requeue fills after a prompt change.
- `src/cli/commands/track.ts` — import the bootstrap helpers from the new shared
  module instead of defining them privately.
- `jobfinder.config.js`, `src/utils/config.ts`, and the `examples/*.config.js`
  files — optionally add `LLM_FILL_MODEL` (it can default to reusing
  `LLM_CODING_MODEL`) and document the new `profile.md` data file. Note that the
  interactive fill overrides `USE_HEADLESS_BROWSER` to run headed.
- `start-pipeline.ts` — no change under the recommendation (fill is on-demand);
  a one-line addition to `TASKS` if the team later wants unattended generation.

Out of scope for the first cut but natural follow-ups: a TUI affordance (a
keybinding on the job-post detail screen to trigger `fill-resume` for the
selected post and a column showing whether a `fillScript` is cached), and tests
covering the bootstrap ordering and the no-submit invariant.

## Risks and open questions

- **Form interaction is harder than scraping.** The parser-script prompt is
  read-only and explicitly forbids navigation; a fill script must type into
  inputs, operate custom dropdown widgets, and often follow an apply link to a
  different ATS domain. React-controlled inputs ignore a naive `input.value =
...` assignment, so the generated `fillForm` must set values through the native
  setter and dispatch `input`/`change` events (a well-known pattern the prompt
  should mandate). An alternative worth prototyping is to have the script return
  a declarative plan of `{ selector, action, value }` steps that the Node-side
  runner then applies through patchright's `page.fill` / `page.selectOption` /
  `page.setInputFiles` locator APIs, which handle framework events correctly and
  are more robust than in-page assignment. This trades the "store one JS string"
  symmetry with `parserScript` for reliability; the choice can be made during
  implementation.
- **The no-submit invariant must be enforced, not merely requested.** Beyond
  instructing the LLM never to submit, the harness should refuse to click submit
  controls and should treat a navigation away from the form during validation or
  fill as a failure, so a stray click cannot fire off a real application.
- **Reaching the form.** Many postings gate the form behind an "Apply" button, a
  login, or a captcha. Discovery handles the apply-button hop; auth and captcha
  walls are recorded as terminal no-result states with a clear reason, matching
  how the scraping stages already handle unreachable content.
- **Profile completeness.** Forms ask for fields no résumé contains (desired
  salary, start date, demographic questions). The applicant profile should carry
  sensible defaults or explicit "leave blank" markers so `fillForm` does not
  invent answers; anything it cannot fill confidently is left for the human.
- **Command name.** `fill-resume` is proposed; `autofill` is an alternative. This
  is cosmetic and easy to change before release.
