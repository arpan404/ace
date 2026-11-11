/*
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00, ADR 0117): a
 * client whose client_id is an HTTPS URL serves its metadata there. The daemon fetches it
 * itself (through `MetadataFetch`, which keeps off private networks), requires the document's
 * client_id to equal the URL, keeps the redirect URIs it may use, and caches the result.
 */
import { z } from "zod";
import type { ClientProblem, OAuthClient } from "./client.ts";
import { redirectAcceptable } from "./redirects.ts";

export const metadataMaxBytes = 64 * 1024;
export const metadataTimeoutMs = 5_000;
const cacheDefaultMs = 5 * 60_000;
const cacheMaxMs = 60 * 60_000;
const cacheEntries = 64;
/** Metadata documents fetched at once, across clients; more sign-ins wait for none of them. */
export const metadataFetchesAtOnce = 4;

/** One GET of a metadata URL; never follows redirects, rejects on network failure. */
export type MetadataFetch = (
  url: URL,
  signal: AbortSignal,
) => Promise<{ status: number; headers: Headers; body: Uint8Array }>;

const Document = z.looseObject({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(256),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(32),
  token_endpoint_auth_method: z.string().optional(),
});

/** The URL a client_id names when it is a metadata document's, or undefined. */
export function metadataUrl(clientId: string): URL | undefined {
  if (!clientId.startsWith("https://")) return undefined;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/");
  const valid =
    url.protocol === "https:" &&
    (url.port === "" || url.port === "443") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !clientId.includes("#") &&
    url.pathname !== "/" &&
    // The URL must be the document's own, not one a parser rewrote (§3).
    url.href === clientId &&
    !segments.includes(".") &&
    !segments.includes("..");
  return valid ? url : undefined;
}
/** How long a document may be kept, from its Cache-Control; 0: don't keep it. */
export function cacheFor(headers: Headers): number {
  const control = headers.get("cache-control")?.toLowerCase() ?? "";
  if (/\b(no-store|no-cache)\b/.test(control)) return 0;
  const age = /\bmax-age=(\d+)/.exec(control)?.[1];
  return age === undefined ? cacheDefaultMs : Math.min(Number(age) * 1000, cacheMaxMs);
}
/** Checks a fetched document against the URL it came from. */
export function readDocument(
  url: URL,
  response: { status: number; body: Uint8Array },
): OAuthClient | ClientProblem {
  const host = url.hostname;
  if (response.status !== 200)
    return { problem: `${host} answered ${response.status} for its client metadata.` };
  if (response.body.length > metadataMaxBytes)
    return { problem: `${host}'s client metadata is too large.` };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return { problem: `${host}'s client metadata isn't JSON.` };
  }
  const document = Document.safeParse(json);
  if (!document.success)
    return { problem: `${host}'s client metadata lacks client_id, client_name or redirect_uris.` };
  if (document.data.client_id !== url.href)
    return { problem: `${host}'s client metadata names another client_id.` };
  const method = document.data.token_endpoint_auth_method;
  if (method !== undefined && method !== "none")
    return { problem: `ace signs in public clients only; ${host} asks for ${method}.` };
  const redirectUris = document.data.redirect_uris.filter(redirectAcceptable);
  if (!redirectUris.length) return { problem: `${host} lists no usable redirect address.` };
  return {
    kind: "cimd",
    clientId: url.href,
    name: document.data.client_name,
    domain: host,
    redirectUris,
  };
}

/** Metadata documents fetched lately, keyed by client_id; a fetch at a time per client. */
export class ClientMetadata {
  private cache = new Map<string, { client: OAuthClient; until: number }>();
  private pending = new Map<string, Promise<OAuthClient | ClientProblem>>();
  private fetch: MetadataFetch;
  private now: () => number;
  constructor(options: { fetch: MetadataFetch; now: () => number }) {
    this.fetch = options.fetch;
    this.now = options.now;
  }
  resolve(clientId: string): Promise<OAuthClient | ClientProblem> {
    const url = metadataUrl(clientId);
    if (!url) return Promise.resolve({ problem: "That client_id isn't a valid metadata URL." });
    const cached = this.cache.get(clientId);
    if (cached && cached.until > this.now()) return Promise.resolve(cached.client);
    const running = this.pending.get(clientId);
    if (running) return running;
    if (this.pending.size >= metadataFetchesAtOnce)
      return Promise.resolve({ problem: "ace is busy checking other sign-ins. Try again soon." });
    const next = this.load(url).finally(() => this.pending.delete(clientId));
    this.pending.set(clientId, next);
    return next;
  }
  private async load(url: URL): Promise<OAuthClient | ClientProblem> {
    let response: Awaited<ReturnType<MetadataFetch>>;
    try {
      response = await this.fetch(url, AbortSignal.timeout(metadataTimeoutMs));
    } catch {
      return { problem: `Couldn't fetch ${url.hostname}'s client metadata.` };
    }
    const client = readDocument(url, response);
    const keep = cacheFor(response.headers);
    if ("problem" in client || keep === 0) return client;
    this.cache.delete(client.clientId);
    if (this.cache.size >= cacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(client.clientId, { client, until: this.now() + keep });
    return client;
  }
}
