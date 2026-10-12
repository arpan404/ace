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
  const pending: DefaultTreeAdapterMap["node"][] = [document];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if ("childNodes" in node) pending.push(...node.childNodes);
    if (!("tagName" in node)) continue;
    if ("content" in node) pending.push(node.content);
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
  return { valid: diagnostics.length === 0, bytes, maxBytes: maxHtmlBytes, diagnostics };
}
