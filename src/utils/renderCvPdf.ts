import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium } from 'patchright';

/** Render a complete HTML document to a PDF using a one-shot headless
 * Chromium. Writes to `outputPath` and returns the resolved absolute path.
 * The parent directory is created on demand.
 *
 * Always headless regardless of `USE_HEADLESS_BROWSER` — this is a print
 * job, not a scrape, so there's no value in opening a visible window. */
export async function renderCvPdf(args: {
  html: string;
  outputPath: string;
  format?: 'Letter' | 'A4';
}): Promise<{ path: string }> {
  const { html, format = 'Letter' } = args;
  const outputPath = resolve(args.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // `setContent` with `networkidle` waits for any external resources the
    // HTML pulls in (the seed template is self-contained, but a user's
    // local override might include CDN fonts/images).
    await page.setContent(html, { waitUntil: 'networkidle' });

    // Let playwright write the file directly — the buffer/writeFile detour
    // ran into Buffer-vs-Uint8Array typing friction with no real benefit.
    // Margins match the 0.6in default career-ops uses; the template's
    // `.page { padding: 2px 0 }` is intentionally near-zero so the printer
    // margins are the single source of whitespace.
    await page.pdf({
      path: outputPath,
      format,
      printBackground: true,
      margin: {
        top: '0.6in',
        right: '0.6in',
        bottom: '0.6in',
        left: '0.6in',
      },
    });
  } finally {
    await browser.close();
  }

  return { path: outputPath };
}
