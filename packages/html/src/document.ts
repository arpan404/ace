import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { HtmlMode, HtmlStyleKit } from "@ace/protocol";
import { validateHtml } from "./validation.ts";
import { withoutScripts } from "./mode.ts";
import { baseStyles } from "./base-styles.ts";
import { legacyBaseStyles } from "./base-styles-v1.ts";
import { frameBridge, pageBridge, pageBridgeHash, themeProperties } from "./scripts.ts";

/**
 * Inline scripts and styles only; no endpoints, storage, workers, frames, forms, eval or
 * provider credentials. Images and fonts may be inlined as `data:`/`blob:`. Every HTML string
 * sink goes through the page bridge's Trusted Types default policy.
 */
export const htmlCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types default ace-raw; webrtc 'block'";
/** A static page runs only the bridge: no authored script, handler or `javascript:` URL. */
export const staticHtmlCsp = htmlCsp.replace(
  "script-src 'unsafe-inline'",
  `script-src ${pageBridgeHash}`,
);
export { themeProperties };
export type ThemeProperty = (typeof themeProperties)[number];
export type HtmlTheme = Partial<Record<ThemeProperty, string>> & {
  /**
   * The app's used color scheme. Chromium paints an opaque light canvas behind a frame whose
   * scheme differs from its embedder's, so every nested document declares the app's scheme.
   */
  colorScheme?: "light" | "dark";
};
/** The theme as a rendered page receives it live; the page keeps its state. */
export interface HtmlThemeMessage {
  type: "ace.html.theme";
  tokens: Partial<Record<ThemeProperty, string>>;
  scheme?: "light" | "dark";
}
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
const dnsOptOut = '<meta http-equiv="x-dns-prefetch-control" content="off">';
function schemeMeta(theme: HtmlTheme): string {
  return theme.colorScheme ? `<meta name="color-scheme" content="${theme.colorScheme}">` : "";
}
/** Only token values that cannot leave a CSS declaration. */
function safeTokens(theme: HtmlTheme): Partial<Record<ThemeProperty, string>> {
  return Object.fromEntries(
    themeProperties.flatMap((key) => {
      const value = theme[key];
      return value && !/[<>{};]/.test(value) ? [[key, value]] : [];
    }),
  );
}
export function themeMessage(theme: HtmlTheme): HtmlThemeMessage {
  return {
    type: "ace.html.theme",
    tokens: safeTokens(theme),
    ...(theme.colorScheme ? { scheme: theme.colorScheme } : {}),
  };
}
/** The kit `html_render` publishes against now; stored on each new page as `kit`. */
export const styleKitVersion = 2;
/** The kit a page was written for: pages from before kits were versioned keep the first one. */
function kitStyles(kit: HtmlStyleKit | undefined): string {
  return kit === undefined || kit < 2 ? legacyBaseStyles : baseStyles;
}
function themedDocument(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
): string {
  const document = parse(mode === "static" ? withoutScripts(html) : html);
  const policy = mode === "static" ? staticHtmlCsp : htmlCsp;
  const root = document.childNodes.find(
    (node): node is DefaultTreeAdapterMap["element"] =>
      "tagName" in node && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is DefaultTreeAdapterMap["element"] =>
      "tagName" in node && node.tagName === "head",
  );
  if (!head) throw new Error("HTML document has no head");
  const tokens = Object.entries(safeTokens(theme))
    .map(([key, value]) => `--${key}:${value}`)
    .join(";");
  const prefix = parseFragment(
    `${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><meta name="referrer" content="no-referrer">${schemeMeta(theme)}<style>${kitStyles(kit)}</style><style>:root{${tokens}}html{background:transparent;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0;display:flow-root}*{box-sizing:border-box}</style><script>${pageBridge}</script>`,
  );
  head.childNodes.unshift(...prefix.childNodes);
  return serialize(document);
}
/** The outer document scrolls its page: full screen, a window, the phone's viewer. */
const scrolling = "html,body{margin:0}";
/**
 * The outer document is sized to its page, inline in a transcript. While the app eases the frame
 * to a new height the page briefly overflows it; a scrollbar that took room then would narrow
 * the page, re-wrap its text and change its height again, over and over. Its scrollbar is hidden,
 * so the page keeps one width whatever the frame's height.
 */
const fitted = "html,body{margin:0}html{scrollbar-width:none}html::-webkit-scrollbar{display:none}";

function outerDocument(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
  root: string,
): string {
  if (!validateHtml(html).valid) throw new Error("Invalid visualization document");
  const page = themedDocument(html, theme, mode, kit);
  return `<!doctype html><html><head>${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(htmlCsp)}"><meta name="referrer" content="no-referrer">${schemeMeta(theme)}<style>${root}iframe{width:100%;border:0;display:block}</style></head><body><template id="ace-page"><iframe title="Visualization content" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attribute(page)}"></iframe></template><script>${frameBridge}</script></body></html>`;
}

/** A data URL starts with an opaque origin. */
const dataUrl = (document: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(document.toWellFormed())}`;

/**
 * A trusted outer document owns frame-src, so even script-driven child navigation is blocked.
 * Each frame has a separate opaque origin. Height crosses out and the theme crosses in; nothing
 * else does. A static page has its scripts stripped and blocked; an interactive one runs them.
 * `kit` is the item's stored style kit; `undefined` (a page from before kits were versioned)
 * gets the first kit.
 */
export function visualizationDocument(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
): string {
  return outerDocument(html, theme, mode, kit, scrolling);
}
export function visualizationUrl(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
): string {
  return dataUrl(visualizationDocument(html, theme, mode, kit));
}
/** The same document for a frame the app sizes to its page (inline in a transcript). */
export function inlineVisualizationUrl(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
): string {
  return dataUrl(outerDocument(html, theme, mode, kit, fitted));
}
/**
 * The downloadable and web new-window form: the same sandbox inside a standalone page. Outside
 * the desktop app's visualization session, network hints are limited only by the page bridge.
 */
export function visualizationWindow(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
): string {
  const policy = htmlCsp.replace("frame-src 'none'", "frame-src data:");
  return `<!doctype html><html><head>${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><title>ace visualization</title>${schemeMeta(theme)}<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style></head><body><iframe title="Visualization" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${attribute(visualizationUrl(html, theme, mode, kit))}"></iframe></body></html>`;
}
