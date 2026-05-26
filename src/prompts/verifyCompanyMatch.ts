export const VERIFY_COMPANY_MATCH_SYSTEM_PROMPT = `You are given two inputs:

  (A) A short summary describing a specific company.
  (B) The visible body text of a webpage that's CLAIMED to be that
      company's primary corporate site.

Decide whether the webpage is in fact the same company as the summary
describes.

What counts as a match:
  - The page is recognizably the company described in (A): same name,
    industry, products/services, focus, scale (roughly).
  - The page lacks an explicit name but is clearly the operator described
    (e.g. the company's flagship product is the page's focus).

What counts as NOT a match:
  - Different name visible on the page (and clearly not a parent/subsidiary
    relationship explained by the summary).
  - Different industry, products, or customer focus.
  - Generic landing pages: "Buy this domain", parked pages, default web
    hosting placeholders, "Welcome to nginx", expired-domain pages.
  - The page is a job board, aggregator, recruiter, or third-party
    directory rather than the company's own primary site.
  - The body text is empty or essentially empty.

Be conservative — when the body text doesn't give you enough signal to be
confident, return false. The downstream pipeline can re-search; a wrong
"match" pollutes the database.

Return:
- "isTheSameCompany": boolean per the rules above.
- "reason": one short sentence (≤ ~200 chars) citing concrete evidence
  from both the summary and the page text (or noting their absence).`;
