import { createHash } from "node:crypto";

/** The custom scheme the packaged renderer is served from (`app://ace/…`). */
export const appScheme = "app";
export const appOrigin = `${appScheme}://ace`;

/**
 * Content Security Policy for the renderer. Scripts come only from the app bundle (plus the
 * hashed inline theme-boot script from index.html); network access only to loopback daemons
 * and selected remote daemons (the session request gate enforces selection). Development adds
 * the Vite server and its HMR socket and allows inline scripts for React refresh.
 */
export function contentSecurityPolicy(options: {
  dev?: { origin: string } | undefined;
  /** `sha256-…` hashes of inline scripts in the built index.html. */
  inlineScripts?: readonly string[];
  /** Extra daemon origins (a remote `wss://` daemon). */
  daemonOrigins?: readonly string[];
  /** A session request allowlist enforces selected origins for an already-loaded document. */
  dynamicDaemons?: boolean;
}): string {
  const dev = options.dev?.origin;
  const devSocket = dev?.replace(/^http/, "ws");
  const loopback = [
    "http://127.0.0.1:*",
    "ws://127.0.0.1:*",
    "http://localhost:*",
    "ws://localhost:*",
    "http://[::1]:*",
    "ws://[::1]:*",
  ];
  /**
   * The local daemon's dev-server previews (ADR 0008): one `p<port>-<generation>` host per
   * forwarded port under `preview.localhost`, framed and renewed in the background (a no-cors
   * sign-in fetch).
   */
  const previews = "http://*.preview.localhost:*";
  const hashes = (options.inlineScripts ?? []).map((hash) => `'${hash}'`);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", ...hashes, ...(dev ? [dev, "'unsafe-inline'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'", ...(dev ? [dev] : [])],
    // The ACP registry's agent icons (one-colour SVGs, drawn as images; never scripts).
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      "http://127.0.0.1:*",
      "https://cdn.agentclientprotocol.com",
      ...(dev ? [dev] : []),
    ],
    "font-src": ["'self'", "data:", ...(dev ? [dev] : [])],
    "connect-src": [
      "'self'",
      ...loopback,
      previews,
      ...(options.daemonOrigins ?? []).flatMap((origin) => [
        origin,
        origin.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
      ]),
      ...(options.dynamicDaemons ? ["https:", "wss:"] : []),
      ...(dev && devSocket ? [dev, devSocket] : []),
    ],
    "media-src": ["'self'", "blob:", "data:"],
    // `blob:` holds typed attachment previews. Chat visualizations are `<webview>` guests, never
    // frames under this policy.
    "frame-src": ["http://127.0.0.1:*", "http://localhost:*", previews, "blob:"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${[...new Set(values)].join(" ")}`)
    .join("; ");
}

function scriptHash(source: string): string {
  return `sha256-${createHash("sha256").update(source).digest("base64")}`;
}

/** Hashes for every inline `<script>` in an HTML document, for `script-src`. */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) =>
    scriptHash(match[1] ?? ""),
  );
}

/**
 * The packaged renderer's policy. Chat visualizations are `<webview>` guests in their own locked
 * session (visualization-isolation.ts), so this policy never applies to their scripts.
 */
export function packagedPolicy(options: {
  index: string;
  daemonOrigins: readonly string[];
  dynamicDaemons: boolean;
}): string {
  return contentSecurityPolicy({
    inlineScripts: inlineScriptHashes(options.index),
    daemonOrigins: options.daemonOrigins,
    dynamicDaemons: options.dynamicDaemons,
  });
}

/**
 * Where the renderer may navigate itself: only its own origin. Compared by scheme and host,
 * because Node's `URL.origin` is "null" for every custom scheme such as `app:`.
 */
export function isAppUrl(url: string, rendererOrigin: string): boolean {
  try {
    const target = new URL(url);
    const own = new URL(rendererOrigin);
    return target.protocol === own.protocol && target.host === own.host && own.host !== "";
  } catch {
    return false;
  }
}

/** Links the user may open in the system browser. */
export function isExternalUrl(url: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
