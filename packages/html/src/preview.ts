import { z } from "zod";

/** The widths html_preview lays a page out at: a phone, and the desktop message column. */
export const previewWidths = [360, 760] as const;
/** The tallest preview image, in CSS pixels. */
export const previewMaxHeight = 2000;
/** Text drawn smaller than this, in CSS pixels after every scale, is hard to read. */
export const smallTextPx = 11;

/**
 * Runs in the page's own frame once it has settled; returns `PreviewFacts`. Finds the outermost
 * elements that reach past the frame's sides (an SVG counts as one element), boxes that hide
 * content sideways with `overflow: hidden`, and every visible text run with its rendered size:
 * the computed font size times the element's scale (an SVG's viewBox scale for its text).
 */
export const previewMeasure = `(() => {
  const view = document.documentElement.clientWidth;
  const name = (element) => {
    const raw = typeof element.className === 'string' ? element.className : (element.className && element.className.baseVal) || '';
    const classes = raw.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    return element.localName + (element.id ? '#' + element.id : '') + (classes.length ? '.' + classes.join('.') : '');
  };
  const outside = [];
  const clipped = [];
  const walk = (parent) => {
    for (const element of parent.children) {
      if (outside.length >= 24) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.position === 'fixed') continue;
      const box = element.getBoundingClientRect();
      if (box.width > 0 && (box.right > view + 0.5 || box.left < -0.5)) {
        outside.push({ element: name(element), left: Math.round(box.left), width: Math.round(box.width) });
        continue;
      }
      if (element.namespaceURI === 'http://www.w3.org/2000/svg') continue;
      const sideways = style.overflowX;
      if (sideways === 'hidden' || sideways === 'clip') {
        if (element.scrollWidth > element.clientWidth + 1 && clipped.length < 12)
          clipped.push({ element: name(element), hidden: element.scrollWidth - element.clientWidth });
        continue;
      }
      if (sideways === 'auto' || sideways === 'scroll') continue;
      walk(element);
    }
  };
  walk(document.body);
  const texts = [];
  let runs = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.data.replace(/\\s+/g, ' ').trim();
    const element = node.parentElement;
    if (!text || !element || element.closest('script,style,noscript')) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const area = range.getBoundingClientRect();
    if (area.width < 1 || area.height < 1) continue;
    let size = parseFloat(style.fontSize) || 0;
    if (element instanceof SVGGraphicsElement) {
      const matrix = element.getScreenCTM();
      if (matrix) size *= Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
    } else if (element instanceof HTMLElement && element.offsetWidth > 0) {
      const ratio = element.getBoundingClientRect().width / element.offsetWidth;
      if (ratio > 0 && ratio < 8) size *= ratio;
    }
    runs++;
    if (texts.length < 400 && size < 16) texts.push({ text: text.slice(0, 40), size: Math.round(size * 10) / 10 });
  }
  return { view, pageWidth: document.documentElement.scrollWidth, outside, clipped, texts, runs };
})()`;

/** What `previewMeasure` returns, read leniently: a page script cannot break the report. */
export const PreviewFacts = z.object({
  view: z.number().catch(0),
  pageWidth: z.number().catch(0),
  outside: z
    .array(z.object({ element: z.string(), left: z.number(), width: z.number() }))
    .catch([]),
  clipped: z.array(z.object({ element: z.string(), hidden: z.number() })).catch([]),
  texts: z.array(z.object({ text: z.string(), size: z.number() })).catch([]),
  runs: z.number().catch(0),
});
export type PreviewFacts = z.infer<typeof PreviewFacts>;

export interface PreviewMeasurement {
  width: number;
  contentHeight: number;
  /** The image's height: the content height, cut at `previewMaxHeight`. */
  imageHeight: number;
  facts: unknown;
}

const list = (items: string[], limit: number) =>
  items.slice(0, limit).join(", ") +
  (items.length > limit ? `, +${items.length - limit} more` : "");

/** One line per width: height, sideways overflow and small text, terse enough for a context. */
export function previewReport(measurements: readonly PreviewMeasurement[]): string {
  return measurements.map(widthLine).join("\n");
}

function widthLine(measurement: PreviewMeasurement): string {
  const facts = PreviewFacts.catch({
    view: 0,
    pageWidth: 0,
    outside: [],
    clipped: [],
    texts: [],
    runs: 0,
  }).parse(measurement.facts);
  const parts = [
    `height ${measurement.contentHeight}px${measurement.imageHeight < measurement.contentHeight ? ` (image cut at ${measurement.imageHeight}px)` : ""}`,
  ];
  const view = facts.view || measurement.width;
  const wide = facts.pageWidth > view + 1;
  if (wide || facts.outside.length > 0) {
    const sticking = facts.outside.map((entry) => {
      const past = Math.max(entry.left + entry.width - view, -entry.left);
      return `${entry.element} ${entry.width}px wide, ${Math.round(past)}px past the edge`;
    });
    parts.push(
      `overflows sideways${wide ? ` (page ${facts.pageWidth}px)` : ""}${sticking.length ? `: ${list(sticking, 4)}` : ""}`,
    );
  } else parts.push("no sideways overflow");
  if (facts.clipped.length > 0)
    parts.push(
      `clipped: ${list(
        facts.clipped.map((entry) => `${entry.element} hides ${entry.hidden}px`),
        3,
      )}`,
    );
  const small = facts.texts
    .filter((entry) => entry.size < smallTextPx)
    .toSorted((a, b) => a.size - b.size);
  parts.push(
    small.length > 0
      ? `${small.length} text run${small.length === 1 ? "" : "s"} under ${smallTextPx}px: ${list(
          small.map((entry) => `"${entry.text}" ${entry.size}px`),
          3,
        )}`
      : `no text under ${smallTextPx}px`,
  );
  return `${measurement.width}px: ${parts.join("; ")}.`;
}
