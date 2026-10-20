import { z } from "zod";

/*
 * Sign-ins that travel with a thread's pages when they move from the desktop's views to ace's
 * Chromium (the desktop's screen locked). The desktop reads its partition's cookies
 * (`ace.cookies`, Electron's own cookie store); this turns them into CDP cookie parameters and
 * plants them in the target context before any tab loads. Decoding is lenient: a cookie that
 * doesn't parse is left behind, never fatal. Cookie values are never logged.
 */

/** A cookie as CDP's `Storage.setCookies` takes it. */
export interface CarriedCookie {
  name: string;
  value: string;
  /** Host-only cookies are set by URL; domain cookies by domain. */
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Seconds since the epoch; absent for a session cookie. */
  expires?: number;
}

/** At most this many cookies travel (a browser keeps about this many per profile). */
export const maxCarriedCookies = 3_000;
/** A browser refuses a cookie whose name and value exceed this together. */
const maxCookieBytes = 4_096;

const Reply = z.object({ cookies: z.array(z.unknown()) });
const DesktopCookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().min(1).max(253),
  hostOnly: z.boolean().optional(),
  path: z.string().max(1_024).optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  session: z.boolean().optional(),
  expirationDate: z.number().finite().optional(),
  sameSite: z.string().optional(),
});

const sameSites: Record<string, CarriedCookie["sameSite"]> = {
  strict: "Strict",
  lax: "Lax",
  no_restriction: "None",
};

/** The desktop's `ace.cookies` reply as cookies to plant; anything unreadable is dropped. */
export function carriedCookies(raw: unknown): CarriedCookie[] {
  const reply = Reply.safeParse(raw);
  if (!reply.success) return [];
  const cookies: CarriedCookie[] = [];
  for (const entry of reply.data.cookies) {
    if (cookies.length >= maxCarriedCookies) break;
    const parsed = DesktopCookie.safeParse(entry);
    if (!parsed.success) continue;
    const cookie = parsed.data;
    if (Buffer.byteLength(cookie.name) + Buffer.byteLength(cookie.value) > maxCookieBytes) continue;
    const host = cookie.domain.replace(/^\./, "");
    if (!host || /[\s/]/.test(host)) continue;
    const path = cookie.path?.startsWith("/") ? cookie.path : "/";
    const sameSite = sameSites[cookie.sameSite ?? ""];
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      // A host-only cookie must stay host-only: CDP makes any `domain` a domain cookie.
      ...(cookie.hostOnly
        ? { url: `${cookie.secure ? "https" : "http"}://${host}${path}` }
        : { domain: cookie.domain.startsWith(".") ? cookie.domain : `.${host}` }),
      path,
      ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
      ...(sameSite ? { sameSite } : {}),
      ...(!cookie.session && cookie.expirationDate !== undefined
        ? { expires: cookie.expirationDate }
        : {}),
    });
  }
  return cookies;
}

/**
 * Sets `cookies` in a browser context (the default one when no id). One call for all; if the
 * browser refuses the batch (one cookie it won't take), each goes alone and the refused ones
 * stay behind. Resolves with how many were set.
 */
export async function plantCookies(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  cookies: readonly CarriedCookie[],
  browserContextId?: string,
): Promise<number> {
  if (!cookies.length) return 0;
  const context = browserContextId ? { browserContextId } : {};
  try {
    await send("Storage.setCookies", { cookies, ...context });
    return cookies.length;
  } catch {
    let set = 0;
    for (const cookie of cookies) {
      try {
        await send("Storage.setCookies", { cookies: [cookie], ...context });
        set++;
      } catch {
        // This one stays behind; the rest still travel.
      }
    }
    return set;
  }
}
