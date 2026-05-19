export const EXTRACT_USER_FILTER_PREFS_SYSTEM_PROMPT = `You extract two job-board filter values from a user's free-form interests text.

You receive: the user's interests as markdown.

Return:
- \`division\`: the department/function the user wants — a short noun phrase a typical careers-page filter would accept (e.g. "engineering", "design", "data science", "product"). Prefer the broadest term that still matches what the user said. If the user wrote a specific role (e.g. "senior software engineer"), map it to its containing function ("engineering"). If nothing in the text identifies a function at all, return "engineering" as a reasonable default.
- \`location\`: the geographic preference — a short string like "Toronto, ON", "Waterloo, Ontario", "Remote", or "United States". Prefer the most specific place the user mentions. If the user mentions both a city and remote, choose the city. If only remote is mentioned, return "Remote". If no location is mentioned at all, return "Remote" as a reasonable default.

Both fields must be non-empty strings. Do not invent specifics the text doesn't support — when in doubt, fall back to the defaults stated above.`;
