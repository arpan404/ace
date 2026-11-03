/**
 * Response helpers for the account API. Every response is uncacheable and frames nothing; the
 * HTML pages are in pages.ts.
 */

export function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** Generic error bodies: a code, never a reason that helps an attacker. */
export const fail = (status: number, error: string) => json(status, { error });

/** Adds the headers every account response carries, and CORS for an allowed origin. */
export function secure(response: Response, origin: string | undefined): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  // Only the sign-in pages (pages.ts) set their own, slightly wider, policies.
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "no-referrer");
  if (!headers.has("Content-Security-Policy"))
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
  }
  return new Response(response.body, { status: response.status, headers });
}

const opaque = /^Bearer ([A-Za-z0-9_-]{43})$/;
/** The 43-character opaque token in `Authorization: Bearer`, if well formed. */
export function bearer(request: Request): string | undefined {
  return request.headers.get("Authorization")?.match(opaque)?.[1];
}

export function cookie(request: Request, name: string): string | undefined {
  for (const part of request.headers.get("Cookie")?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** A JSON request body of at most `limit` bytes, or undefined. */
export async function jsonBody(request: Request, limit: number): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > limit) return undefined;
  const text = await request.text();
  if (text.length > limit) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
