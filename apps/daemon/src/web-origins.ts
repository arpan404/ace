import { z } from "zod";

/**
 * The packaged desktop renderer's origin (ADR 0054: `app://ace/`, a privileged standard scheme).
 * The desktop's `ace://` scheme only carries deep links into the app and never loads a page, so
 * no request ever arrives with it as its Origin.
 */
export const desktopOrigin = "app://ace";

/** ace's hosted web app. Allowed only while `remote.hostedWebApp` is on. */
export const hostedWebOrigin = "https://app.acehq.dev";

/** One http(s) origin exactly as a browser sends it: scheme, host and port, nothing else. */
const WebOrigin = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  }, "Expected an http(s) origin such as http://localhost:5173");

/**
 * `ACE_WEB_ORIGINS`: comma-separated origins of web apps (served anywhere but the daemon) that may
 * call the daemon's cross-origin access routes with its token.
 */
export const WebOrigins = z
  .string()
  .transform((value) => value.split(",").filter((entry) => entry.trim() !== ""))
  .pipe(z.array(WebOrigin).max(32));

/** The origins a browser page may read the access routes from. Every route still needs a token or code. */
export interface WebOriginAllowlist {
  has(origin: string): boolean;
  /** Admit or drop the hosted web app as `remote.hostedWebApp` changes. */
  allowHosted(allowed: boolean): void;
}

/** The desktop app and the configured origins, plus the hosted web app while it is allowed. */
export function webOriginAllowlist(configured: readonly string[] = []): WebOriginAllowlist {
  const fixed = new Set([desktopOrigin, ...configured]);
  let hosted = false;
  return {
    has: (origin) => fixed.has(origin) || (hosted && origin === hostedWebOrigin),
    allowHosted(allowed) {
      hosted = allowed;
    },
  };
}
