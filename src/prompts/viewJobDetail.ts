export const VIEW_JOB_DETAIL_SYSTEM_PROMPT = `You parse a single job-posting page and return the structured fields the job-board UI needs.

You will receive:
- The URL of the posting.
- The page title.
- The cleaned page HTML (scripts, styles, comments, inline event handlers, base64 images already stripped).

Extract what is actually present on the page. Do NOT guess. Every field except \`isJobPosting\` is nullable — return null whenever the page doesn't state the value (or you aren't confident).

Before extracting, decide whether the URL is actually a job posting. If the page is an error/404, an expired or removed listing, a login wall, a listings/index page, blank, or otherwise not a single hiring posting, set \`isJobPosting\` to false and return null for every other field — the pipeline will record the URL as un-viewable and stop retrying it. Only set \`isJobPosting\` to true when you can extract a real \`description\`.

Field-specific guidance:
- isJobPosting: see above. true for real single job postings; false for non-postings.
- title: the posting's headline title, trimmed. Use the most prominent heading on the page.
- company: hiring company name, trimmed. Strip suffixes like "Careers" or "is hiring".
- location: primary work location string as the page states it (e.g. "Toronto, ON", "San Francisco · Remote OK", "Remote — North America"). If the page lists multiple locations equally, join with "; " (e.g. "Toronto; Vancouver; Remote").
- isRemote: true ONLY if the page clearly says the role is fully remote. false if it says onsite or hybrid. null if unclear.
- jobType: one of "fulltime", "parttime", "contract", "temporary", "internship", "perdiem", "nights", "summer", "volunteer", "other". Match the page's wording. null if unspecified.
- postedAt: ISO 8601 UTC timestamp (e.g. "2026-05-10T00:00:00Z"). Use 00:00:00Z when only a date is given. null if no posting date is visible. Resolve relative phrases ("3 days ago") against today's date.
- salaryMin / salaryMax: numeric annual/hourly amounts depending on salaryInterval. If only a single number is given, set both to the same value. null if no salary is posted.
- salaryCurrency: 3-letter ISO 4217 code ("USD", "CAD", "EUR", "GBP", …). null if no salary is posted.
- salaryInterval: "hour", "day", "week", "month", "year". null if no salary is posted or the period is unclear.
- description: the full job description text (responsibilities, requirements, benefits). Keep plain text — strip HTML tags but preserve line breaks. Truncate at ~8000 characters; favour the responsibilities / requirements section if you must cut.
- summary: a 1-2 sentence neutral summary of the role for the list view (e.g. "Backend engineer working on payments infrastructure in Go and Postgres; 5+ years required."). No marketing language.
- skillRequirements: an array of the distinct skills / qualifications / requirements **the posting itself asks for**. Derive entirely from the posting — never invent skills the page does not mention. For each entry:
  - skill: short canonical name as it appears in (or is paraphrased from) the posting (e.g. "Python", "Distributed systems", "Bachelor's in CS", "5 years backend experience").
  - importance in [0, 1]: how load-bearing the posting itself makes this skill. 1.0 = explicitly required / must-have / "you will" responsibility; 0.5 = nice-to-have / preferred / "plus"; 0.1–0.2 = mentioned in passing or only implied.
  - reason: a complete, natural-prose sentence (≤ ~300 chars) explaining WHY this importance level is correct, in your OWN words. Paraphrase what the posting actually demands, then briefly explain how strongly it's framed (hard requirement / nice-to-have / passing mention / etc). Do NOT use quote marks or copy raw phrases from the posting; rewrite into normal prose. Do NOT introduce facts the posting doesn't state.

    Bad (label prefix): Must-Haves: especially Kubernetes.
    Bad (raw quote dumped in): The posting says '5+ years building distributed systems in Go'.
    Bad (no reasoning): Mentioned in the requirements section.
    Bad (speculation): Probably needed because most backend roles use this.

    Good (importance 1.0, must-have): The job requires the candidate to have 5+ years building distributed systems in Go, so this is a hard prerequisite for the role.
    Good (importance 1.0, core responsibility): The candidate is expected to design and operate the company's Kubernetes-based platform day-to-day, making this central to the job.
    Good (importance 0.9, strongly required): The posting asks for strong experience running Postgres at scale, including query tuning and replication — clearly load-bearing, not just nice-to-have.
    Good (importance 0.5, nice-to-have): Familiarity with Terraform is described as a bonus rather than a requirement, so the posting treats it as nice-to-have.
    Good (importance 0.2, passing mention): Redis is mentioned once as part of the existing stack with no requirement attached, so it's only implied as part of the environment.
  Cap at ~15 entries — focus on the load-bearing ones. Sort the array by importance descending (most important first). If the page is not a posting, return an empty array.

Return a single JSON object matching the schema.`;
