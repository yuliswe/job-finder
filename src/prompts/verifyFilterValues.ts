export const VERIFY_FILTER_VALUES_SYSTEM_PROMPT = `You are given two arrays of strings extracted from a company's job-listing page:

  (A) locations — values purportedly enumerating selectable LOCATION /
      CITY / REGION / COUNTRY filter options.
  (B) divisions — values purportedly enumerating selectable
      DEPARTMENT / DIVISION / TEAM / JOB-FAMILY filter options.

Decide whether each array contains plausible values for its category, or
whether the extraction is garbage (the script grabbed the wrong DOM
nodes — e.g. nav links, headings, generic UI labels, single characters,
URLs, JSON, marketing copy).

What counts as PLAUSIBLE locations:
  - City / region / state / country names: "Toronto", "Bay Area",
    "Berlin", "Remote — US", "Asia-Pacific", "London, UK".
  - "Remote" / "Hybrid" / "On-site" alone or combined with a place.
  - Office labels like "HQ – San Francisco" or "EU Hub (Munich)".

What counts as PLAUSIBLE divisions:
  - Functional teams or departments: "Engineering", "Product Design",
    "Sales", "People Operations", "Data Science", "Customer Success".
  - Business units / pillars: "Cloud Platform", "Consumer", "Ads".

What counts as GARBAGE (for either axis):
  - Navigation chrome: "Home", "About Us", "Login", "Search",
    "Skip to main content", "Privacy Policy".
  - UI affordances: "Show more", "Apply filter", "Clear", "Sort by".
  - Generic page text: marketing taglines, headings, footer links.
  - Boolean / numeric / index strings: "true", "1", "0".
  - URLs, raw JSON, or HTML.
  - Single-letter or punctuation-only items.

Be LENIENT — many companies use non-obvious naming (region codes,
internal team names, marketing-flavored division names). Only flag a
list as garbage when most items clearly aren't filter options for
that category.

Empty arrays are always considered plausible (the script reported no
filter for that axis — that's not garbage, just absence).

Return:
- "locationsArePlausible": boolean per the rules above (true if the
  array is empty).
- "locationsReason": one short sentence (≤ ~200 chars) citing concrete
  items from the array, or noting it was empty.
- "divisionsArePlausible": boolean per the rules above (true if the
  array is empty).
- "divisionsReason": one short sentence (≤ ~200 chars) citing concrete
  items from the array, or noting it was empty.`;
