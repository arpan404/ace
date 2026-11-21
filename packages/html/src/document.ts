import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { HtmlMode, HtmlStyleKit } from "@ace/protocol";
import { validateHtml } from "./validation.ts";
import { withoutScripts } from "./mode.ts";
import { baseStyles } from "./base-styles.ts";
import { legacyBaseStyles } from "./base-styles-v1.ts";
import {
  frameBridge,
  pageBridge,
  pageBridgeHash,
  panelFrameBridge,
  panelPageBridge,
  themeProperties,
} from "./scripts.ts";
import { mcpAppFrameBridge, mcpAppPageBridge } from "./mcp-app-scripts.ts";

/**
 * What a sandboxed page's frame carries: a chat visualization's height and theme, a package
 * panel's typed channel (ADR 0200 §5.2), or an MCP app page's JSON-RPC, held to the panel's
 * bounds (ADR 0202 §4). Same documents, sandbox and CSP every way.
 */
type Channel = "visualization" | "panel" | "mcp-app";

const pageBridges: Record<Channel, string> = {
  visualization: "",
  panel: `<script>${panelPageBridge}</script>`,
  "mcp-app": `<script>${mcpAppPageBridge}</script>`,
};
const frameBridges: Record<Channel, string> = {
  visualization: frameBridge,
  panel: panelFrameBridge,
  "mcp-app": mcpAppFrameBridge,
};

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
  channel: Channel,
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
    `${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><meta name="referrer" content="no-referrer">${schemeMeta(theme)}<style>${kitStyles(kit)}</style><style>:root{${tokens}}html{background:transparent;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0;display:flow-root}*{box-sizing:border-box}</style><script>${pageBridge}</script>${pageBridges[channel]}`,
  );
  head.childNodes.unshift(...prefix.childNodes);
  return serialize(document);
}
/** A panel's page takes its whole place and scrolls itself. */
const filling = "html,body{margin:0;height:100%}iframe{height:100%}";
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
  channel: Channel = "visualization",
): string {
  const page = pageDocument(html, theme, mode, kit, channel);
  return outerShell(theme, root, channel, `srcdoc="${attribute(page)}"`);
}

/** The page as its frame loads it: themed, guarded and under its own CSP. */
function pageDocument(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
  channel: Channel,
): string {
  if (!validateHtml(html).valid) throw new Error("Invalid visualization document");
  return themedDocument(html, theme, mode, kit, channel);
}

/** The trusted outer document around the page frame; `page` sets the frame's `srcdoc`, if given. */
function outerShell(theme: HtmlTheme, root: string, channel: Channel, page: string): string {
  const bridge = frameBridges[channel];
  return `<!doctype html><html><head>${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(htmlCsp)}"><meta name="referrer" content="no-referrer">${schemeMeta(theme)}<style>${root}iframe{width:100%;border:0;display:block}</style></head><body><template id="ace-page"><iframe title="Visualization content" sandbox="allow-scripts" referrerpolicy="no-referrer" ${page}></iframe></template><script>${bridge}</script></body></html>`;
}

/** A data URL starts with an opaque origin. */
const dataUrl = (document: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(document.toWellFormed())}`;

/**
 * A page for a frame that loads a URL: the outer document, small whatever the page's size, and
 * the page, which the app hands it once that document has loaded (`pageMessage`). Put inside the
 * URL, a page of a couple of MiB would pass the 2 MiB URL Chromium loads, and the frame would
 * stay blank.
 */
export interface FramedPage {
  url: string;
  page: string;
}

function framed(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
  root: string,
  channel: Channel,
): FramedPage {
  return {
    url: dataUrl(outerShell(theme, root, channel, "")),
    page: pageDocument(html, theme, mode, kit, channel),
  };
}

/** A visualization that scrolls itself, for a frame: full screen and its own window. */
export function visualizationFrame(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
): FramedPage {
  return framed(html, theme, mode, kit, scrolling, "visualization");
}
/** A visualization the app sizes to its page, for a frame inline in a transcript. */
export function inlineVisualizationFrame(
  html: string,
  theme: HtmlTheme,
  mode: HtmlMode,
  kit: HtmlStyleKit | undefined,
): FramedPage {
  return framed(html, theme, mode, kit, fitted, "visualization");
}
/** A package panel's page (`panelUrl`), for a frame. */
export function panelFrame(html: string, theme: HtmlTheme): FramedPage {
  return framed(html, theme, "interactive", styleKitVersion, filling, "panel");
}
/** An MCP app's page (`mcpAppPanelUrl`), for a frame. */
export function mcpAppPanelFrame(html: string, theme: HtmlTheme): FramedPage {
  return framed(html, theme, "interactive", styleKitVersion, filling, "mcp-app");
}

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
 * A package panel's page (ADR 0200 §5.2) in the same sandbox as a visualization: the trusted
 * outer document, the opaque-origin `allow-scripts` frame and its `default-src 'none'` CSP, the
 * page bridge, and the panel's typed channel in place of height and theme alone. It fills its
 * place and scrolls itself, and always runs its scripts, on the current style kit.
 */
export function panelUrl(html: string, theme: HtmlTheme): string {
  return dataUrl(outerDocument(html, theme, "interactive", styleKitVersion, filling, "panel"));
}

/**
 * An MCP app's page as a panel (ADR 0202 §4): exactly a package panel's sandbox and policy, so
 * whatever the page declares it reaches no network, with MCP Apps' JSON-RPC in place of the
 * panel's own messages.
 */
export function mcpAppPanelUrl(html: string, theme: HtmlTheme): string {
  return dataUrl(outerDocument(html, theme, "interactive", styleKitVersion, filling, "mcp-app"));
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
  // The outer document as `srcdoc`, not a `data:` URL, which a page of a couple of MiB outgrows.
  const outer = visualizationDocument(html, theme, mode, kit);
  return `<!doctype html><html><head>${dnsOptOut}<meta http-equiv="Content-Security-Policy" content="${attribute(htmlCsp)}"><title>ace visualization</title>${schemeMeta(theme)}<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style></head><body><iframe title="Visualization" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attribute(outer)}"></iframe></body></html>`;
}
