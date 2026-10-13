import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { validateHtml } from "./validation.ts";
import { frameBridge, pageBridge } from "./scripts.ts";

/** No endpoints, storage, workers, frames, forms, eval or provider credentials. */
export const htmlCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'; webrtc 'block'";
export const themeProperties = [
  "background",
  "foreground",
  "muted",
  "muted-foreground",
  "card",
  "card-foreground",
  "border",
  "primary",
  "primary-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "radius",
  "font-sans",
  "font-mono",
] as const;
export type HtmlTheme = Partial<Record<(typeof themeProperties)[number], string>> & {
  /**
   * The app's used color scheme. Chromium paints an opaque light canvas behind a frame whose
   * scheme differs from its embedder's, so every nested document declares the app's scheme.
   */
  colorScheme?: "light" | "dark";
};
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
// Only this fixed resize bridge can execute in the authored document. Keep its hash in sync.
const staticCsp = htmlCsp.replace(
  "script-src 'unsafe-inline'",
  "script-src 'sha256-zQwQ5npUN7TEHLCavZxMcj2/3BX1SkJJQGr/a/zYZxk='",
);
const dnsOptOut = '<meta http-equiv="x-dns-prefetch-control" content="off">';
function schemeMeta(theme: HtmlTheme): string {
  return theme.colorScheme ? `<meta name="color-scheme" content="${theme.colorScheme}">` : "";
}

/** Network hints bypass CSP in Blink; author JavaScript therefore stays disabled. */
function removeAuthorScripts(document: DefaultTreeAdapterMap["document"]): void {
  const pending: DefaultTreeAdapterMap["node"][] = [document];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if ("attrs" in node) node.attrs = node.attrs.filter((attr) => !attr.name.startsWith("on"));
    if ("content" in node) pending.push(node.content);
    if ("childNodes" in node) {
      node.childNodes = node.childNodes.filter(
        (child) => !("tagName" in child && child.tagName === "script"),
      );
      pending.push(...node.childNodes);
    }
  }
}
function themedDocument(html: string, theme: HtmlTheme): string {
  const document = parse(html);
  removeAuthorScripts(document);
  const root = document.childNodes.find(
    (node): node is DefaultTreeAdapterMap["element"] =>
      "tagName" in node && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is DefaultTreeAdapterMap["element"] =>
      "tagName" in node && node.tagName === "head",
  );
  if (!head) throw new Error("HTML document has no head");
  const tokens = themeProperties
    .flatMap((key) => {
      const value = theme[key];
      return value && !/[<>{};]/.test(value) ? [`--${key}:${value}`] : [];
    })
    .join(";");
  const prefix = parseFragment(
    `${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(staticCsp)}"><meta name="referrer" content="no-referrer">${schemeMeta(theme)}<style>:root{${tokens}}html{color:var(--foreground);font-family:var(--font-sans,system-ui);background:transparent}body{margin:0;display:flow-root}*{box-sizing:border-box}</style><script>${pageBridge}</script>`,
  );
  head.childNodes.unshift(...prefix.childNodes);
  return serialize(document);
}
/**
 * A trusted outer document owns frame-src, so even script-driven child navigation is blocked.
 * Each frame has a separate opaque origin. Only height crosses either boundary.
 */
export function visualizationDocument(html: string, theme: HtmlTheme): string {
  if (!validateHtml(html).valid) throw new Error("Invalid visualization document");
  const page = themedDocument(html, theme);
  return `<!doctype html><html><head>${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(htmlCsp)}"><meta name="referrer" content="no-referrer">${schemeMeta(theme)}<style>html,body{margin:0}iframe{width:100%;border:0;display:block}</style></head><body><template id="ace-page"><iframe title="Visualization content" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attribute(page)}"></iframe></template><script>${frameBridge}</script></body></html>`;
}
/**
 * A data URL frame gets an opaque origin but inherits the embedder's CSP, so the embedding app
 * must allow `visualizationScripts` by hash (`@ace/html/scripts`).
 */
export function visualizationUrl(html: string, theme: HtmlTheme): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(visualizationDocument(html, theme).toWellFormed())}`;
}
/** Opening keeps the same sandbox; never open authored HTML as an app-origin blob. */
export function visualizationWindow(html: string, theme: HtmlTheme): string {
  const policy = htmlCsp.replace("frame-src 'none'", "frame-src data:");
  return `<!doctype html><html><head>${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><title>ace visualization</title>${schemeMeta(theme)}<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style></head><body><iframe title="Visualization" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${attribute(visualizationUrl(html, theme))}"></iframe></body></html>`;
}
