import { maxArchiveBytes, previewBytes } from "@ace/marketplace";
import { TurnedOff } from "./turned-off.ts";

/*
 * The thin shell around market.acehq.dev's read routes (ADR 0168 §3). Requests carry no account,
 * device or machine id and no cookie; every answer is size-capped and parsed by the caller.
 */

export type MarketFetch = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
    method?: string;
    body?: Uint8Array<ArrayBuffer> | string;
  },
) => Promise<Response>;

/** A write's answer: its status and its JSON body (undefined when there was none). */
export interface MarketAnswer {
  status: number;
  body: unknown;
}

export class MarketHttpError extends Error {
  override name = "MarketHttpError";
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const jsonBytes = 32 * 1024 * 1024;
const timeoutMs = 30_000;

async function capped(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maximum) throw new MarketHttpError("The market's answer is too large");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new MarketHttpError("The market's answer is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export class MarketHttp {
  readonly origin: string;
  readonly #fetch: MarketFetch;

  constructor(options: { origin: string; fetch: MarketFetch }) {
    const url = new URL(options.origin);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      throw new MarketHttpError("The market is reached over https only");
    this.origin = url.origin;
    this.#fetch = options.fetch;
  }

  async #get(
    path: string,
    headers: Record<string, string> = {},
    write?: { method: string; body?: Uint8Array<ArrayBuffer> | string },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(this.origin + path, {
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        ...(write ? { method: write.method } : {}),
        ...(write?.body === undefined ? {} : { body: write.body }),
      });
    } catch (error) {
      if (error instanceof TurnedOff) throw error;
      throw new MarketHttpError(
        `The market can't be reached: ${error instanceof Error ? error.message : "no answer"}`,
      );
    }
    return response;
  }

  async #json(path: string): Promise<unknown> {
    const response = await this.#get(path);
    if (!response.ok)
      throw new MarketHttpError(`The market answered ${response.status}`, response.status);
    return JSON.parse(new TextDecoder().decode(await capped(response, jsonBytes)));
  }

  /** `/v1/index`, as a delta when `since` and the last `etag` are known. */
  async index(since?: {
    stamp: number;
    etag?: string | undefined;
  }): Promise<
    { unchanged: true } | { unchanged: false; body: unknown; etag?: string | undefined }
  > {
    const path = since ? `/v1/index?since=${since.stamp}` : "/v1/index";
    const response = await this.#get(path, since?.etag ? { "if-none-match": since.etag } : {});
    if (response.status === 304) {
      await response.body?.cancel();
      return { unchanged: true };
    }
    if (!response.ok)
      throw new MarketHttpError(`The market answered ${response.status}`, response.status);
    const body: unknown = JSON.parse(new TextDecoder().decode(await capped(response, jsonBytes)));
    return { unchanged: false, body, etag: response.headers.get("etag") ?? undefined };
  }

  categories = () => this.#json("/v1/categories");
  featured = () => this.#json("/v1/featured");
  entry = (type: string, name: string) =>
    this.#json(`/v1/entries/${encodeURIComponent(type)}/${encodeURIComponent(name)}`);
  version = (type: string, name: string, version: string) =>
    this.#json(
      `/v1/entries/${encodeURIComponent(type)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    );

  discover = () => this.#json("/v1/discover");
  publisher = (handle: string) => this.#json(`/v1/publishers/${encodeURIComponent(handle)}`);

  /** The signed withdrawn list, or undefined before the market has one. */
  withdrawn = () => this.#signed("/v1/withdrawn");
  /** The signed blocklist, verified list and official list (ADR 0173 §8, §13, §14). */
  blocklist = () => this.#signed("/v1/blocklist");
  verified = () => this.#signed("/v1/verified");
  official = () => this.#signed("/v1/official");

  /**
   * A request with any method, its answer read whatever the status, so the caller maps the
   * market's error shape. `headers` may carry a market grant: it goes to this origin only.
   */
  async send(
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: Uint8Array | string } = {},
  ): Promise<MarketAnswer> {
    const sent = options.body;
    const response = await this.#get(path, options.headers, {
      method,
      ...(sent === undefined
        ? {}
        : { body: typeof sent === "string" ? sent : new Uint8Array(sent) }),
    });
    const bytes = await capped(response, jsonBytes);
    const text = new TextDecoder().decode(bytes);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  async #signed(path: string): Promise<unknown> {
    const response = await this.#get(path);
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok)
      throw new MarketHttpError(`The market answered ${response.status}`, response.status);
    return JSON.parse(new TextDecoder().decode(await capped(response, jsonBytes)));
  }

  /** A listing picture or avatar by its sha256, capped at a picture's limit. */
  async picture(kind: "preview" | "avatar", hash: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new MarketHttpError("Not a content hash");
    const response = await this.#get(`/v1/${kind}s/${hash}`, { accept: "image/*" });
    if (!response.ok)
      throw new MarketHttpError(`The market answered ${response.status}`, response.status);
    return capped(response, previewBytes);
  }

  async object(hash: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new MarketHttpError("Not a content hash");
    const response = await this.#get(`/v1/objects/${hash}`, { accept: "application/x-tar" });
    if (!response.ok)
      throw new MarketHttpError(`The market answered ${response.status}`, response.status);
    return capped(response, maxArchiveBytes);
  }
}
