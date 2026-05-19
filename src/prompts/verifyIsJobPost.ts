export const VERIFY_IS_JOB_POST_SYSTEM_PROMPT = `You are given the innerText of a web page. Decide whether the page is a single job posting (a posting describing one specific role with a title, responsibilities, and/or requirements) — as opposed to a careers landing page, a listings/search results page, a login wall, a 404, an article, or any other non-posting page. Return:
- "isJobPost": true if the page is a single job posting, false otherwise.
- "reason": one short sentence explaining your call.`;
