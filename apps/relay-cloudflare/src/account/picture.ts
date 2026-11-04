import { digest } from "./crypto.ts";
import { bearer, fail } from "./respond.ts";
import type { SessionStore } from "./sessions.ts";

/** Pictures larger than this are refused rather than relayed. */
export const PICTURE_MAX_BYTES = 1024 * 1024;
const pictureTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * `GET /v1/account/picture`: the session's own profile picture, fetched by the backend from
 * where WorkOS keeps it, so the apps never load it from a third party and its address never
 * leaves the backend. Only a live session may ask; only an image of a known type and size is
 * relayed.
 */
export function pictureRoute(deps: {
  sessions: Pick<SessionStore, "get">;
  fetch: typeof fetch;
  now: () => number;
}) {
  return async function picture(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return fail(401, "unauthenticated");
    const session = await deps.sessions.get(await digest(token), deps.now());
    if (!session) return fail(401, "unauthenticated");
    if (!session.pictureUrl) return fail(404, "no_picture");
    let upstream: Response;
    try {
      upstream = await deps.fetch(session.pictureUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return fail(502, "picture_unavailable");
    }
    const type = upstream.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const declared = Number(upstream.headers.get("Content-Length") ?? "0");
    if (!upstream.ok || !pictureTypes.has(type) || declared > PICTURE_MAX_BYTES) {
      await upstream.body?.cancel();
      return fail(502, "picture_unavailable");
    }
    const bytes = await upstream.arrayBuffer();
    if (bytes.byteLength > PICTURE_MAX_BYTES) return fail(502, "picture_unavailable");
    return new Response(bytes, {
      status: 200,
      // The account API marks every answer no-store; the apps keep the picture in memory.
      headers: { "Content-Type": type },
    });
  };
}
