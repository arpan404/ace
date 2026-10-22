/*
 * Which raw HTML in forge text is drawn, and with which attributes (ADR 0096). An allowlist:
 * the formatting subset people use on GitHub, drawn as React elements. Anything else (scripts,
 * styles, iframes, forms, event handlers, inline styles, classes) is never an element: its tag
 * shows as text. URLs are kept only when they are http(s), mailto (links) or an in-page anchor;
 * a root-relative path is resolved against the forge host.
 */

/** Elements drawn with their children. */
const containers = new Set([
  "a",
  "abbr",
  "b",
  "bdo",
  "blockquote",
  "caption",
  "center",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "i",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
]);
/** Elements that never hold children. */
const voids = new Set(["br", "hr", "img", "source", "wbr"]);

const attributes: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title", "name", "id"],
  abbr: ["title"],
  bdo: ["dir"],
  details: ["open"],
  img: ["src", "alt", "title", "width", "height", "align"],
  ol: ["start", "type"],
  q: ["cite"],
  source: ["srcset", "media", "type"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  time: ["datetime"],
};
const aligned = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "img"]);
const alignments = new Set(["left", "right", "center", "justify"]);
const dimension = /^\d{1,5}(?:\.\d+)?%?$/;
const count = /^\d{1,4}$/;

/** An allowed element and its kept attributes. */
export type SafeElement = { tag: string; attrs: Readonly<Record<string, string>>; void: boolean };

export function allowedTag(tag: string): boolean {
  return containers.has(tag) || voids.has(tag);
}

/** A link target that may be followed: http(s), mailto, or an anchor on this page. */
export function safeLink(href: string, host: string): string | undefined {
  const value = href.trim();
  if (value.startsWith("#")) return /^#[\w:.-]{1,200}$/.test(value) ? value : undefined;
  try {
    const url =
      value.startsWith("/") && !value.startsWith("//")
        ? new URL(value, `https://${host}`)
        : new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** An image source that may be shown: an absolute http(s) URL (a root path on the forge host). */
export function safeImage(src: string, host: string): string | undefined {
  const value = src.trim();
  try {
    const url =
      value.startsWith("/") && !value.startsWith("//")
        ? new URL(value, `https://${host}`)
        : new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Each URL a `srcset` names, in order (descriptors dropped). */
export function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(/,\s+/)
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

/**
 * `tag` with `attrs` as it may be drawn, or undefined when the tag isn't allowed. `host` is the
 * forge's, for resolving root-relative URLs.
 */
export function safeElement(
  tag: string,
  attrs: ReadonlyMap<string, string>,
  host: string,
): SafeElement | undefined {
  if (!allowedTag(tag)) return undefined;
  const kept: Record<string, string> = {};
  for (const name of attributes[tag] ?? []) {
    const value = attrs.get(name);
    if (value === undefined) continue;
    if (name === "href") {
      const href = safeLink(value, host);
      if (href) kept.href = href;
    } else if (name === "src") {
      const src = safeImage(value, host);
      if (src) kept.src = src;
    } else if (name === "srcset") {
      const urls = srcsetUrls(value).flatMap((url) => safeImage(url, host) ?? []);
      if (urls[0]) kept.srcset = urls[0];
    } else if (name === "width" || name === "height") {
      if (dimension.test(value)) kept[name] = value;
    } else if (name === "colspan" || name === "rowspan" || name === "start") {
      if (count.test(value)) kept[name] = value;
    } else if (name === "name" || name === "id") {
      // The renderer keeps it apart from the app's own ids.
      if (/^[\w:.-]{1,200}$/.test(value)) kept.id = value;
    } else if (name === "dir") {
      if (value === "ltr" || value === "rtl") kept.dir = value;
    } else if (name === "open") kept.open = "";
    else kept[name] = value.slice(0, 1000);
  }
  const align = attrs.get("align")?.toLowerCase();
  if (align && aligned.has(tag) && alignments.has(align)) kept.align = align;
  return { tag, attrs: kept, void: voids.has(tag) };
}
