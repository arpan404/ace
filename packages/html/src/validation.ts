import { parse, type DefaultTreeAdapterMap } from "parse5";
import { maxHtmlDocumentBytes, type HtmlDiagnostics } from "@ace/protocol";

export const maxHtmlBytes = maxHtmlDocumentBytes;
const forbidden = new Set([
  "base",
  "embed",
  "object",
  "iframe",
  "frame",
  "frameset",
  "portal",
  "form",
  "link",
]);
/**
 * CSS that would load something from outside the page: any `@import`, and any `url()`,
 * `src()` or `image-set()` reference that isn't an in-page fragment (`url(#arrow)`, used by
 * SVG markers, gradients and clip paths) or an inline `data:` URL (images, fonts, masks).
 */
function loadsExternalCss(css: string): boolean {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import/i.test(text)) return true;
  for (const match of text.matchAll(
    /(?<![\w-])(?:url|src)\(\s*(["']?)\s*|image-set\(\s*(["'])\s*/gi,
  )) {
    const rest = text.slice((match.index ?? 0) + match[0].length);
    if (!rest.startsWith("#") && !/^data:/i.test(rest)) return true;
  }
  return false;
}
const cssResourceMessage =
  "CSS may use only in-page url(#id) references and inline data: URLs; no @import, files or web addresses.";
/** Diagnostics help authors; the iframe policy remains the execution boundary. */
export function validateHtml(html: string): HtmlDiagnostics {
  const bytes = new TextEncoder().encode(html).byteLength;
  const diagnostics: HtmlDiagnostics["diagnostics"] = [];
  const report = (code: string, message: string) => {
    if (diagnostics.length < 32 && !diagnostics.some((entry) => entry.code === code))
      diagnostics.push({ code, message });
  };
  if (bytes > maxHtmlBytes) report("size", "HTML exceeds the 16 MiB UTF-8 limit.");
  if (!html.trim()) report("empty", "Provide a complete HTML document.");
  if (diagnostics.length) return { valid: false, bytes, maxBytes: maxHtmlBytes, diagnostics };
  const document = parse(html);
  const pending: { node: DefaultTreeAdapterMap["node"]; depth: number }[] = [
    { node: document, depth: 0 },
  ];
  let visited = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const { node, depth } = entry;
    if (++visited > 20000 || depth > 64) {
      report("complexity", "Use at most 20,000 nodes and 64 levels of nesting.");
      break;
    }
    if ("childNodes" in node)
      for (const child of node.childNodes) pending.push({ node: child, depth: depth + 1 });
    if (!("tagName" in node)) continue;
    if ("content" in node) pending.push({ node: node.content, depth: depth + 1 });
    if (forbidden.has(node.tagName))
      report(
        "embedded-content",
        "Frames, forms, plugins, base URLs and external stylesheets are unsupported.",
      );
    if (node.tagName === "meta" && node.attrs.some((attr) => attr.name === "http-equiv"))
      report(
        "http-equiv",
        "HTTP-equivalent metadata, including refresh and authored CSP, is unsupported.",
      );
    for (const attr of node.attrs) {
      if (
        [
          "src",
          "href",
          "xlink:href",
          "action",
          "poster",
          "data",
          "background",
          "srcset",
          "ping",
        ].includes(attr.name)
      ) {
        const value = attr.value.trim();
        const embeddedImage =
          node.tagName === "img" &&
          attr.name === "src" &&
          /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value);
        if (value && !value.startsWith("#") && !embeddedImage)
          report(
            "external-resource",
            "Use inline assets and fragment links; external requests are blocked.",
          );
      }
      if (attr.name === "style" && loadsExternalCss(attr.value))
        report("css-resource", cssResourceMessage);
    }
    if (
      node.tagName === "style" &&
      node.childNodes.some((child) => "value" in child && loadsExternalCss(child.value))
    )
      report("css-resource", cssResourceMessage);
  }
  return { valid: diagnostics.length === 0, bytes, maxBytes: maxHtmlBytes, diagnostics };
}
