import type { Page } from 'patchright';

import { pageEval } from 'src/utils/browser.js';

/**
 * Return the page body's HTML with noise stripped out so it fits in an LLM
 * prompt: drops script/style/svg/meta/etc., HTML comments, inline event
 * handlers and style attributes, replaces data: URLs with a placeholder, and
 * collapses whitespace. Preserves class, id, data-* and aria-* so the LLM
 * can still write reliable selectors.
 */
export async function cleanHtmlForLlm(page: Page): Promise<string> {
  const html = await pageEval(page, () => {
    const root = document.body.cloneNode(true) as HTMLElement;

    for (const el of root.querySelectorAll(
      'script, style, noscript, svg, link, meta, template'
    )) {
      el.remove();
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const comments: ChildNode[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) comments.push(n as ChildNode);
    for (const c of comments) c.remove();

    for (const el of root.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on') || attr.name === 'style') {
          el.removeAttribute(attr.name);
          continue;
        }
        if (
          (attr.name === 'src' ||
            attr.name === 'srcset' ||
            attr.name === 'href') &&
          /^data:/i.test(attr.value)
        ) {
          el.setAttribute(attr.name, 'data:...');
        }
      }
    }

    return root.innerHTML;
  });
  return html.replace(/\s+/g, ' ').trim();
}
