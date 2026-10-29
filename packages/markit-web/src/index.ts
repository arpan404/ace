/**
 * Headless bridge between ace's web client and the `packages/markit` submodule.
 *
 * Everything here is pure (no I/O, no DOM, no globals) so it can be tested directly and stay
 * inside the browser bundle. Building the Wasm worker and copying its static assets lives in
 * `scripts/sync-assets.mjs`; rendering lives in `apps/web/.../markit-prose.tsx`.
 */

export interface MarkitReference {
  kind: "file" | "thread" | "pull_request";
  target: string;
}

const referenceKinds = new Set<string>(["file", "thread", "pull_request"]);

/** The reference kind a markit `onReference` callback carries, or undefined. */
export function asMarkitReferenceKind(kind: string): MarkitReference["kind"] | undefined {
  return referenceKinds.has(kind) ? (kind as MarkitReference["kind"]) : undefined;
}

/** Where the markit web worker is served from. `base` is the app's base path (usually ""). */
export function markitWorkerPath(base?: string): string {
  const root = base ?? "";
  return `${root}/markit/worker.js`;
}

/** Only bytes already on the page may resolve: inline data, object URLs, or `markit:` blobs. */
export function shouldResolveMarkitImage(src: string): boolean {
  return /^(data:image\/|blob:)/i.test(src);
}

/**
 * Whether `src` is a web address the renderer must never fetch on its own. Agent prose shows
 * those as a link the person can choose to open, so tracking pixels stay inert.
 */
export function isMarkitWebImage(src: string): boolean {
  try {
    const url = new URL(src);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Where a link in rendered prose leads: the web, an ace view, or a file on the thread host. */
export type MarkitLinkTarget =
  | { kind: "web"; href: string }
  | { kind: "ace"; href: string }
  | { kind: "local"; path: string };

/**
 * Sorts a link markit handed to the host. Only http(s) and mailto reach the browser; `ace://`
 * and `thread://` stay in the app; a relative path or `file:` URL names a file on the thread's
 * host. Any other scheme (javascript:, data:, custom handlers) is refused.
 */
export function markitLinkTarget(url: string): MarkitLinkTarget | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined) return url.trim() ? { kind: "local", path: url } : undefined;
  if (scheme === "ace" || scheme === "thread") return { kind: "ace", href: url };
  if (scheme === "file") return { kind: "local", path: url };
  if (scheme !== "http" && scheme !== "https" && scheme !== "mailto") return undefined;
  try {
    return { kind: "web", href: new URL(url).href };
  } catch {
    return undefined;
  }
}
