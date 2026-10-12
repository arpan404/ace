import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { HtmlDiagnostics } from "@ace/protocol";

export const maxHtmlBytes = 256 * 1024;
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
/** Diagnostics help authors; the iframe policy remains the execution boundary. */
export function validateHtml(html: string): HtmlDiagnostics {
  const bytes = new TextEncoder().encode(html).byteLength;
  const diagnostics: HtmlDiagnostics["diagnostics"] = [];
  const report = (code: string, message: string) => {
    if (diagnostics.length < 32 && !diagnostics.some((entry) => entry.code === code))
      diagnostics.push({ code, message });
  };
  if (bytes > maxHtmlBytes) report("size", "HTML exceeds the 256 KiB UTF-8 limit.");
  if (!html.trim()) report("empty", "Provide a complete HTML document.");
  if (diagnostics.length) return { valid: false, bytes, maxBytes: maxHtmlBytes, diagnostics };
  const document = parse(html);
  const pending: { node: DefaultTreeAdapterMap["node"]; depth: number }[] = [
    { node: document, depth: 0 },
  ];
  let visited = 0;
  let authoredScripts = false;
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
    if (node.tagName === "script" || node.attrs.some((attr) => attr.name.startsWith("on")))
      authoredScripts = true;
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
      if (attr.name === "style" && /(?:@import|url\s*\()/i.test(attr.value))
        report("css-resource", "Use inline CSS without imports or URL resources.");
    }
    if (
      node.tagName === "style" &&
      node.childNodes.some((child) => "value" in child && /(?:@import|url\s*\()/i.test(child.value))
    )
      report("css-resource", "Use inline CSS without imports or URL resources.");
  }
  const valid = diagnostics.length === 0;
  if (authoredScripts && diagnostics.length < 32)
    report(
      "static-view",
      "Authored scripts and event handlers will not execute. Use HTML and SVG for visible content.",
    );
  return { valid, bytes, maxBytes: maxHtmlBytes, diagnostics };
}
