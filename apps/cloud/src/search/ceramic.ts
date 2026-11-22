/**
 * One search with Ceramic through the owner's AI Gateway (ADR 0210 §2): `provider: "ceramic"`
 * and no `byokAlias`, which bills the gateway's credits. Ceramic's answer is read leniently and
 * within bounds; nothing of it is kept.
 */

/** What of the AI binding a search uses: Workers AI's `websearch`, a fake in tests. */
export type WebSearchBinding = {
  websearch(request: {
    gatewayId: string;
    query: string;
    provider?: string;
    limit?: number;
  }): Promise<Response>;
};

export type Freshness = "day" | "week" | "month" | "year";

export type Result = { url: string; title: string; snippet: string; site: string };

/** The most of Ceramic's answer read: past it, the answer is refused, not buffered. */
export const MOST_ANSWER_BYTES = 256 * 1024;
export const MOST_RESULTS = 10;
const MOST_URL = 2048;
const MOST_TITLE = 300;
const MOST_SNIPPET = 500;
const FRESH_DAYS: Record<Freshness, number> = { day: 1, week: 7, month: 31, year: 366 };

/**
 * The gateway's own error codes that say it turned the call away before sending it to Ceramic,
 * so nothing was billed. Cloudflare's binding contract (Agents › Web search, "Handle errors"):
 * "Every error has a code: the API's own code when it sends one, such as
 * web_search_payment_required, or one derived from the HTTP status". The codes derived from a
 * status prove nothing about where the call stopped, so they, any HTTP status alone, and no
 * answer at all keep the reservation. `web_search_unsupported_runtime` is the runtime refusing
 * before any request (Workers binding docs).
 */
const NOT_SENT = new Set(["web_search_payment_required", "web_search_unsupported_runtime"]);
/** The most of an error answer read for its code. */
const MOST_ERROR_BYTES = 16 * 1024;

/** The error codes an answer's body or a thrown error carries, read leniently. */
function codesIn(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const fields = value as Record<string, unknown>;
  const codes: string[] = [];
  if (typeof fields.code === "string") codes.push(fields.code);
  if (typeof fields.error === "string") codes.push(fields.error);
  else codes.push(...codesIn(fields.error));
  if (Array.isArray(fields.errors)) for (const each of fields.errors) codes.push(...codesIn(each));
  return codes;
}

const provesNotSent = (codes: string[]) => codes.some((code) => NOT_SENT.has(code));

/**
 * Why Ceramic gave nothing usable: a short code, never the query or the answer. `billed` is
 * false only when the gateway clearly turned the call away before it reached Ceramic.
 */
export class CeramicFailed extends Error {
  override name = "CeramicFailed";
  readonly billed: boolean;
  /** Billed unless the gateway's own code proved otherwise: unknown billing keeps it. */
  constructor(code: string, billed = true) {
    super(code);
    this.billed = billed;
  }
}

async function boundedText(response: Response, most: number): Promise<string> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > most) throw new CeramicFailed("answer_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > most) {
      await reader.cancel().catch(() => {});
      throw new CeramicFailed("answer_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const text = (value: unknown, most: number) =>
  typeof value === "string" ? value.trim().slice(0, most) : "";

/** A naive ISO date (Ceramic's `lastModifiedDate`, no zone) read as UTC, or undefined. */
function modifiedAt(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  const at = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Ceramic's items as results: each read on its own, so one odd item never loses the rest. An
 * item without an http(s) URL is dropped; with `freshness`, so is one whose known date is older.
 */
export function readResults(
  body: unknown,
  limit: number,
  freshness: Freshness | undefined,
  now: number,
): Result[] {
  const items =
    typeof body === "object" && body !== null && "items" in body && Array.isArray(body.items)
      ? (body.items as unknown[])
      : [];
  const oldest = freshness ? now - FRESH_DAYS[freshness] * 86_400_000 : undefined;
  const results: Result[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (results.length >= limit) break;
    if (typeof item !== "object" || item === null) continue;
    const fields = item as Record<string, unknown>;
    if (typeof fields.url !== "string" || fields.url.length > MOST_URL) continue;
    let url: URL;
    try {
      url = new URL(fields.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (seen.has(url.href)) continue;
    const modified = modifiedAt(fields.lastModifiedDate);
    if (oldest !== undefined && modified !== undefined && modified < oldest) continue;
    seen.add(url.href);
    results.push({
      url: url.href,
      title: text(fields.title, MOST_TITLE),
      snippet: text(fields.description, MOST_SNIPPET),
      site: url.hostname,
    });
  }
  return results;
}

/** Searches Ceramic once. Throws `CeramicFailed` with a code when it gives nothing usable. */
export async function searchCeramic(
  ai: WebSearchBinding,
  gatewayId: string,
  query: string,
  limit: number,
  freshness: Freshness | undefined,
  now: number,
): Promise<Result[]> {
  let response: Response;
  try {
    response = await ai.websearch({ gatewayId, query, provider: "ceramic", limit });
  } catch (error) {
    throw new CeramicFailed("binding_failed", !provesNotSent(codesIn(error)));
  }
  if (!response.ok) {
    let body: unknown;
    try {
      body = JSON.parse(await boundedText(response, MOST_ERROR_BYTES));
    } catch {
      body = undefined;
    }
    throw new CeramicFailed(`http_${response.status}`, !provesNotSent(codesIn(body)));
  }
  let body: unknown;
  try {
    body = JSON.parse(await boundedText(response, MOST_ANSWER_BYTES));
  } catch (error) {
    throw error instanceof CeramicFailed ? error : new CeramicFailed("not_json");
  }
  return readResults(body, limit, freshness, now);
}
