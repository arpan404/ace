/*
 * Whether the page has been still long enough for a hover preview to open. A wheel, trackpad
 * or scroll anywhere marks it moving; it rests again `restMs` after the last one. Previews ask
 * before they open and close when scrolling starts, so rows sliding under a still pointer never
 * pop their cards. One passive capture listener per document, added on first use.
 */

/** Longer than a row's hover delay, so a delay that started mid-scroll can't open a card. */
const restMs = 500;

interface ScrollRest {
  moving: boolean;
  onMove: Set<() => void>;
}

const rests = new WeakMap<Document, ScrollRest>();

function restOf(doc: Document): ScrollRest {
  const known = rests.get(doc);
  if (known) return known;
  const rest: ScrollRest = { moving: false, onMove: new Set() };
  let settle: ReturnType<typeof setTimeout> | undefined;
  const moved = () => {
    rest.moving = true;
    clearTimeout(settle);
    settle = setTimeout(() => (rest.moving = false), restMs);
    for (const listener of rest.onMove) listener();
  };
  const options = { capture: true, passive: true };
  doc.addEventListener("wheel", moved, options);
  doc.addEventListener("scroll", moved, options);
  rests.set(doc, rest);
  return rest;
}

/** True while the page is scrolling or has scrolled within the last moment. */
export function scrolledRecently(doc: Document): boolean {
  return restOf(doc).moving;
}

/** Call `listener` each time the page scrolls; the result stops it. */
export function onScrollMove(doc: Document, listener: () => void): () => void {
  const rest = restOf(doc);
  rest.onMove.add(listener);
  return () => rest.onMove.delete(listener);
}
