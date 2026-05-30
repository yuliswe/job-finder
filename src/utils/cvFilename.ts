/** Build a tailored-resume PDF filename like
 * `cv-acme-corp-senior-software-engineer-2026-05-30.pdf` from the company
 * and job title. The date suffix means re-runs the same day overwrite the
 * previous file — usually desired, since iteration on the same posting
 * shouldn't litter the resumes folder. */
export function buildCvFilename(args: {
  company: string | null;
  title: string;
}): string {
  const company = slug(args.company) || 'unknown-company';
  const title = slug(args.title) || 'untitled';
  const date = new Date().toISOString().slice(0, 10);
  return `cv-${company}-${title}-${date}.pdf`;
}

/** Lowercase, ASCII-folded, alphanumeric-and-hyphens slug, trimmed to 60
 * chars so even very long job titles don't blow past filesystem limits. */
function slug(s: string | null): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}
