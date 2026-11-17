import type { MarketProblem } from "@ace/protocol/marketplace";

/* Responses the Worker sends. None sets a cookie. */

const jsonType = "application/json; charset=utf-8";

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const response = new Response(JSON.stringify(body), { status, headers });
  response.headers.set("content-type", jsonType);
  return response;
}

/** An error in the API's one shape: `{error, message}`. */
export const failure = (status: number, error: string, message: string, headers?: HeadersInit) =>
  json({ error, message }, status, headers);

export const refused = (problems: MarketProblem[]) =>
  json({ error: "refused", problems: problems.slice(0, 200) }, 422);

export const notFound = () => failure(404, "not_found", "Nothing is here.");
export const tooMany = () =>
  failure(429, "busy", "Too many requests; try again shortly.", { "retry-after": "10" });

/** A request body read up to `limit` bytes; undefined when it is longer. */
export async function readCapped(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= limit)) return undefined;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A JSON body of at most `limit` bytes, or undefined. */
export async function readJson(request: Request, limit = 4 * 1024 * 1024): Promise<unknown> {
  const bytes = await readCapped(request, limit);
  if (!bytes) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

const encoder = new TextEncoder();
/** Whether two secrets are equal, in time that doesn't depend on where they differ. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all(
    [given, expected].map(
      async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
    ),
  );
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= (a?.[index] ?? 0) ^ (b?.[index] ?? 0);
  return difference === 0;
}

/** A strong ETag for a body: its sha256. */
export async function etagOf(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return `"${Array.from(digest.subarray(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}"`;
}
