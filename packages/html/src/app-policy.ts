import { createHash } from "node:crypto";

/*
 * The app's own Content Security Policy, shared by the desktop shell (sent as a header) and the
 * hosted web build (written into index.html as it is built), so both run the page under one
 * policy (ADR 0096): scripts only from the bundle and its hashed inline boot scripts, nothing
 * inline otherwise, no plugins, and images, media and frames only from the places listed.
 */

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
      "blob:",
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
