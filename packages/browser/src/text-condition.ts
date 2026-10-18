/**
 * One visible-text probe, run in the page. A native `textContent` check rules out most polls
 * cheaply; only a document that contains the text is walked, text nodes only, checking layout
 * just for the nodes the walk reads. The probe reports how long it ran so the caller can space
 * polls out on very large pages instead of refusing them.
 */
export function textCondition(text: string): string {
  return `(() => {
    const started = performance.now();
    const done = (matched) => ({ matched, elapsed: performance.now() - started });
    if (document.readyState === 'loading' || !document.body) return done(false);
    const search = ${JSON.stringify(text)};
    if (!(document.body.textContent ?? '').includes(search)) return done(false);
    const skipped = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node, tail = '';
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || skipped.has(parent.tagName)) continue;
      const value = node.nodeValue ?? '';
      if (!value) continue;
      range.selectNodeContents(node);
      if (!range.getClientRects().length || getComputedStyle(parent).visibility === 'hidden') continue;
      const content = tail + value;
      if (content.includes(search)) return done(true);
      tail = search.length > 1 ? content.slice(1 - search.length) : '';
    }
    return done(false);
  })()`;
}

/**
 * The pause before the next probe: at least `intervalMs`, and long enough that probing never
 * takes more than a fifth of the page's main thread, capped at one second.
 */
export function nextProbeDelay(elapsedMs: number, intervalMs = 50): number {
  return Math.min(1000, Math.max(intervalMs, Math.ceil(elapsedMs * 4)));
}
