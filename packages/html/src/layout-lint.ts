import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { HtmlDiagnostics } from "@ace/protocol";
import { validateHtml } from "./validation.ts";

type Diagnostic = HtmlDiagnostics["diagnostics"][number];
type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];

/** The narrowest column a page is shown in: the chat on a phone. */
export const narrowestColumn = 360;
/** Smallest text, in CSS px at the narrowest column, that a page may publish. */
const minimumText = 9;

const viewportUnit = /(?<![\w-])\d*\.?\d+(?:[dsl]?v(?:h|b|max|min))\b/i;
const fixedPosition = /(?<![\w-])position\s*:\s*fixed\b/i;
const fixedWidth = /(?<![\w-])width\s*:\s*(\d+(?:\.\d+)?)px/gi;
const pxFontSize = /(?<![\w-])font-size\s*:\s*(\d*\.?\d+)px/gi;
const anyFontSize = /(?<![\w-])font-size\s*:\s*(\d*\.?\d+)(?:px)?\s*(?:[;}"!]|$)/gi;

function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name)?.value;
}
function textOf(node: Element): string {
  return node.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
}
/** Inside the kit's sideways scroller, or a box whose own style scrolls sideways. */
function insideScroller(ancestors: readonly Element[]): boolean {
  return ancestors.some(
    (node) =>
      /(?:^|\s)ace-scroll-x(?:\s|$)/.test(attribute(node, "class") ?? "") ||
      /(?<![\w-])overflow(?:-x)?\s*:\s*(?:auto|scroll)\b/.test(attribute(node, "style") ?? ""),
  );
}
interface CssRule {
  selector: string;
  body: string;
  /** Inside an at-rule that only applies on wide screens (`@media (min-width: …)`). */
  wideOnly: boolean;
}
/** Leaf `selector { declarations }` rules with their at-rule context. Enough for lint, not a parser. */
function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const context: string[] = [];
  let prelude = "";
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (char === "{") {
      context.push(prelude.trim());
      prelude = "";
    } else if (char === "}") {
      const selector = context.pop() ?? "";
      if (prelude.includes(":") && !selector.startsWith("@"))
        rules.push({
          selector,
          body: prelude,
          wideOnly: context.some((rule) => /^@(?:media|container)\b[^{]*min-width/i.test(rule)),
        });
      prelude = "";
    } else prelude += char;
  }
  return rules;
}
function numbers(pattern: RegExp, text: string): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1])).filter(Number.isFinite);
}
function viewBoxWidth(svg: Element): number | undefined {
  const parts = (attribute(svg, "viewbox") ?? attribute(svg, "viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = parts[2];
  return parts.length === 4 && width !== undefined && width > 0 ? width : undefined;
}
function svgFontSizes(svg: Element, pageRules: readonly CssRule[]) {
  const sizes: number[] = [];
  let hasText = false;
  const pending: Node[] = [svg];
  while (pending.length) {
    const node = pending.pop();
    if (!node || !("tagName" in node)) continue;
    pending.push(...node.childNodes);
    if (node.tagName === "text" || node.tagName === "tspan") hasText = true;
    const size = Number.parseFloat(attribute(node, "font-size") ?? "");
    if (Number.isFinite(size)) sizes.push(size);
    sizes.push(...numbers(anyFontSize, attribute(node, "style") ?? ""));
    if (node.tagName === "style") sizes.push(...numbers(anyFontSize, textOf(node)));
  }
  for (const rule of pageRules)
    if (/(?:^|[\s,>+~])(?:svg|text|tspan)\b|\.[\w-]*(?:label|text)/i.test(rule.selector))
      sizes.push(...numbers(anyFontSize, rule.body));
  return { hasText, sizes };
}

interface PageCss {
  css: string;
  rules: CssRule[];
  svgs: { node: Element; ancestors: Element[] }[];
  /** Fixed widths in `style` attributes outside an `ace-scroll-x`. */
  inlineWidths: number[];
}
function readPage(html: string): PageCss {
  const document = parse(html);
  const styles: string[] = [];
  const svgs: PageCss["svgs"] = [];
  const inlineWidths: number[] = [];
  const pending: { node: Node; ancestors: Element[] }[] = [{ node: document, ancestors: [] }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const { node, ancestors } = entry;
    if (!("childNodes" in node)) continue;
    const next = "tagName" in node ? [...ancestors, node] : ancestors;
    for (const child of node.childNodes) pending.push({ node: child, ancestors: next });
    if (!("tagName" in node)) continue;
    if ("content" in node) pending.push({ node: node.content, ancestors: next });
    if (node.tagName === "style") styles.push(textOf(node));
    if (node.tagName === "svg") svgs.push({ node, ancestors });
    const style = attribute(node, "style");
    if (style) {
      styles.push(`[style]{${style}}`);
      if (!insideScroller(ancestors)) inlineWidths.push(...numbers(fixedWidth, style));
    }
  }
  const css = styles.join("\n");
  return { css, rules: cssRules(css), svgs, inlineWidths };
}
function collector() {
  const found = new Map<string, string>();
  return {
    report(code: string, message: string) {
      if (!found.has(code)) found.set(code, message);
    },
    diagnostics: (): Diagnostic[] => [...found].map(([code, message]) => ({ code, message })),
  };
}

/**
 * What breaks the frame itself, whatever the width: the frame grows to fit the page, so
 * viewport units and a full-height root grow it without end, and `position: fixed` pins to the
 * whole page. These are wrong on every page, so they are read from the markup. Rendering never
 * runs this: pages published before a rule existed still display.
 */
export function lintHtmlLayout(html: string): Diagnostic[] {
  const { report, diagnostics } = collector();
  const { css, rules } = readPage(html);
  if (viewportUnit.test(css))
    report(
      "viewport-height",
      "Size without vh/dvh/svh: the frame grows to fit the page, so viewport units grow it without end. Let content set the height, or give a mockup's screen a fixed px height.",
    );
  if (
    rules.some(
      (rule) =>
        /(?:^|[\s,])(?:html|body|:root)\b/.test(rule.selector) &&
        /(?<![\w-])(?:min-)?height\s*:\s*100%/.test(rule.body),
    )
  )
    report(
      "root-height",
      "Leave html and body at their content height (no height:100%): the frame sizes to the page.",
    );
  if (fixedPosition.test(css))
    report(
      "fixed-position",
      "position:fixed pins to the whole page, which is as tall as its content. Put overlays, sheets and toasts in a position:relative box with a fixed height, using position:absolute.",
    );

  return diagnostics();
}

/**
 * A guess at what overflows or shrinks unreadably on a phone, read from the markup and CSS. Only
 * for when the page can't be laid out (`measuredLayoutProblems` is the real check): it misses
 * fixed grid tracks and min-widths, and flags some text that renders fine.
 */
export function estimateHtmlLayout(html: string): Diagnostic[] {
  const { report, diagnostics } = collector();
  const { css, rules, svgs, inlineWidths } = readPage(html);
  const wide = [
    ...rules
      .filter(
        (rule) =>
          rule.selector !== "[style]" && !rule.wideOnly && !rule.selector.includes("ace-scroll-x"),
      )
      .flatMap((rule) => numbers(fixedWidth, rule.body)),
    ...inlineWidths,
  ].filter((width) => width > narrowestColumn);
  if (wide.length)
    report(
      "fixed-width",
      `A fixed width of ${Math.max(...wide)}px is wider than the ${narrowestColumn}px phone column and gets cut off. Use width:min(100%, ${Math.max(...wide)}px), max-width, or flexible grid/flex sizing; give wide-by-nature content an overflow-x:auto box.`,
    );

  const tiny = numbers(pxFontSize, css).filter((size) => size > 0 && size < 10);
  if (tiny.length)
    report(
      "text-too-small",
      `Text at ${Math.min(...tiny)}px is too small to read in chat. Use at least 11px (12px for labels and axis text).`,
    );

  for (const { node, ancestors } of svgs) {
    if (insideScroller(ancestors)) continue;
    const width = viewBoxWidth(node);
    if (!width) continue;
    const { hasText, sizes } = svgFontSizes(node, rules);
    if (!hasText) continue;
    const declaredWidth = attribute(node, "width")?.trim() ?? "";
    const declared = /^\d+(?:\.\d+)?(?:px)?$/.test(declaredWidth)
      ? Number.parseFloat(declaredWidth)
      : Number.NaN;
    const shown = Math.min(narrowestColumn, Number.isFinite(declared) ? declared : width);
    const smallest = sizes.length ? Math.min(...sizes) : 14;
    const rendered = (smallest * shown) / width;
    if (rendered < minimumText)
      report(
        "svg-text-too-small",
        `An SVG drawn ${Math.round(width)} units wide shrinks to ${shown}px on a phone, so its ${smallest}-unit labels render at about ${rendered.toFixed(1)}px. Draw it narrower (viewBox about 360–600 wide, labels 13–14 units), lay it out in HTML, or give it an overflow-x:auto box.`,
      );
  }
  return diagnostics();
}

/**
 * What `html_render` checks from the markup before it lays the page out: the safety rules every
 * display path also enforces, then the frame rules only publishing enforces.
 */
export function checkHtmlForPublish(html: string): HtmlDiagnostics {
  const safety = validateHtml(html);
  if (safety.diagnostics.some((entry) => entry.code === "size" || entry.code === "empty"))
    return safety;
  const diagnostics = [...safety.diagnostics, ...lintHtmlLayout(html)].slice(0, 32);
  return { ...safety, valid: diagnostics.length === 0, diagnostics };
}
