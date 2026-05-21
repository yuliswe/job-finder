/** Normalize a raw URL to the form `JobSource.url` stores: lowercase
 * hostname only, no protocol, no `www.` prefix
 * (e.g. "https://www.Acme.com/about" → "acme.com"). Returns null when the
 * input doesn't parse as a URL.
 *
 * The `JobSource.url` column has a matching DB-level CHECK constraint, so
 * any code that writes the column without going through this helper will
 * fail at INSERT/UPDATE time with a constraint violation. */
export function normalizeJobSourceUrl(raw: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const hostname = new URL(withScheme).hostname.toLowerCase();
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  } catch {
    return null;
  }
}
