import { ForgeMutationOutcome, MutationDispatch, isForgeMutation } from "./mutation.ts";
import { createHash } from "node:crypto";
import { immutable } from "./immutable.ts";
import { z } from "zod";
import { ForgeError } from "./errors.ts";
import { redactData } from "./redact.ts";
import type { CommandRunner } from "./command.ts";

import { ReadBudget } from "./read-budget.ts";

const envelope = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
});
const graphqlResult = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        extensions: z.looseObject({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});
/** Successful fields or unknown errors cannot prove that a mutation was refused. */
function assertGraphqlResult(body: unknown, dispatch: MutationDispatch, retryAt: number): void {
  const parsed = graphqlResult.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const { data, errors } = parsed.data;
  if (!errors?.length) return;
  const refused = !data || Object.values(data).every((value) => value === null);
  const codes = errors.map((error) => error.type ?? error.extensions?.code);
  let error: ForgeError | undefined;
  if (refused && codes.every((code) => code === "RATE_LIMITED"))
    error = new ForgeError("rate_limit", retryAt);
  else if (refused && codes.every((code) => code === "FORBIDDEN" || code === "UNAUTHORIZED"))
    error = new ForgeError("forbidden");
  else if (refused && codes.every((code) => code === "NOT_FOUND"))
    error = new ForgeError("not_found");
  else if (refused && codes.every((code) => code === "GRAPHQL_VALIDATION_FAILED"))
    error = new ForgeError("invalid_data");
  if (!error) throw new ForgeError("invalid_data");
  dispatch.reject();
  throw error;
}
function rateLimitRetryAt(headers: Record<string, string>, now: number): number {
  const seconds = Number(headers["retry-after"]);
  const reset = Number(headers["x-ratelimit-reset"]) * 1_000;
  return Number.isFinite(seconds) && seconds >= 0
    ? now + seconds * 1_000
    : Number.isFinite(reset) && reset > now
      ? reset
      : now + 60_000;
}
export type Page = {
  body: unknown;
  headers: Record<string, string>;
  bytes: number;
  version: string;
  identityChanged?: true;
};
type Cached = Page;
export class GhApi {
  readonly #runner: CommandRunner;
  readonly #command: string;
  readonly #host: string;
  readonly #now: () => number;
  readonly #cache = new Map<string, Cached>();
  #cacheBytes = 0;
  constructor(options: {
    runner: CommandRunner;
    command?: string;
    host: string;
    now: () => number;
  }) {
    this.#runner = options.runner;
    this.#command = options.command ?? "gh";
    this.#host = options.host;
    this.#now = options.now;
  }
  async request(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    dispatch = new MutationDispatch(),
  ): Promise<Page> {
    const request = {
      command: this.#command,
      args: ["api", path, "--method", method],
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
      signal,
      mode: "json" as const,
    };
    try {
      return await this.#request(path, signal, body, method, dispatch);
    } catch (error) {
      throw isForgeMutation(request) ? dispatch.failure(error) : error;
    }
  }
  async #request(
    path: string,
    signal: AbortSignal,
    body: unknown,
    method: string,
    dispatch: MutationDispatch,
  ): Promise<Page> {
    const args = [
      "api",
      path,
      "--hostname",
      this.#host,
      "--include",
      "--method",
      method,
      "--header",
      "Accept: application/vnd.github+json",
    ];
    const input = body === undefined ? undefined : JSON.stringify(body);
    const reusable = !isForgeMutation({
      args,
      ...(input === undefined ? {} : { input }),
      command: this.#command,
      signal,
      mode: "json",
    });
    const cacheKey =
      method === "GET"
        ? path
        : `graphql:${createHash("sha256")
            .update(input ?? "")
            .digest("hex")}`;
    const cached = reusable ? this.#cache.get(cacheKey) : undefined;
    if (method === "GET" && cached?.headers.etag)
      args.push("--header", `If-None-Match: ${cached.headers.etag}`);
    if (input !== undefined) args.push("--input", "-");
    const output = await this.#runner({
      command: this.#command,
      args,
      signal,
      mode: "json",
      ...(input === undefined ? {} : { input }),
      dispatch,
    });
    const split = /\r?\n\r?\n/.exec(output.stdout);
    if (!split) throw new ForgeError("cli");
    const headerText = output.stdout.slice(0, split.index);
    const status = /^HTTP\/[\d.]+ (\d{3})/i.exec(headerText);
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    const parsed = envelope.safeParse({ status: Number(status?.[1]), headers });
    if (!parsed.success) throw new ForgeError("invalid_data");
    const code = parsed.data.status;
    const text = output.stdout.slice(split.index + split[0].length);
    let rateMessage = "";
    if (code === 403) {
      try {
        rateMessage = z.object({ message: z.string() }).parse(JSON.parse(text)).message;
      } catch {
        /* A malformed error body does not obscure the HTTP status. */
      }
    }
    if (code === 304) {
      if (!cached) throw new ForgeError("invalid_data");
      this.#retain(cacheKey, cached);
      return cached;
    }
    if (
      code === 429 ||
      (code === 403 &&
        (headers["x-ratelimit-remaining"] === "0" ||
          headers["retry-after"] !== undefined ||
          /secondary rate limit|rate limit exceeded|abuse detection/i.test(rateMessage)))
    ) {
      dispatch.reject();
      throw new ForgeError("rate_limit", rateLimitRetryAt(headers, this.#now()));
    }
    if ([401, 403, 404, 409, 422].includes(code)) dispatch.reject();
    if (code === 404) throw new ForgeError("not_found");
    if (code === 401 || code === 403) throw new ForgeError("forbidden");
    if (code === 409 || code === 422) throw new ForgeError("conflict");
    if (code < 200 || code >= 300) throw new ForgeError("cli");
    // gh exits 1 for GraphQL errors even with HTTP 200. Classify complete bodies
    // before the CLI fallback, including before any cached representation is reused.
    if (path === "graphql") {
      if (output.truncated) throw new ForgeError("invalid_data");
      let graphqlBody: unknown;
      try {
        graphqlBody = JSON.parse(text);
      } catch {
        throw new ForgeError("invalid_data");
      }
      assertGraphqlResult(graphqlBody, dispatch, rateLimitRetryAt(headers, this.#now()));
    }
    if (output.code !== 0) throw new ForgeError("cli");
    const version = createHash("sha256").update(text).digest("hex");
    const safeHeaders = {
      ...(headers.etag && /^[\x20-\x7e]{1,512}$/.test(headers.etag) ? { etag: headers.etag } : {}),
      ...(headers.link ? { link: headers.link } : {}),
    };
    if (cached?.version === version) {
      cached.headers = safeHeaders;
      this.#retain(cacheKey, cached);
      return cached;
    }
    let data: unknown;
    try {
      data = text.trim() ? immutable(redactData(JSON.parse(text))) : null;
    } catch {
      throw new ForgeError("invalid_data");
    }
    const page: Page = {
      version,
      bytes: Buffer.byteLength(text),
      body: data,
      headers: safeHeaders,
      ...(output.identityChanged ? { identityChanged: true } : {}),
    };
    if (!reusable) {
      this.#cache.clear();
      this.#cacheBytes = 0;
    } else {
      this.#retain(cacheKey, page);
    }
    return page;
  }
  /** Completion reconciles the entry actually retained, never an earlier request snapshot. */
  #retain(key: string, page: Page): void {
    const current = this.#cache.get(key);
    if (current) {
      this.#cache.delete(key);
      this.#cacheBytes -= current.bytes;
    }
    if (page.bytes > 8_388_608) return;
    while (this.#cache.size >= 128 || this.#cacheBytes + page.bytes > 8_388_608) {
      const oldest = this.#cache.entries().next().value;
      if (!oldest) break;
      this.#cache.delete(oldest[0]);
      this.#cacheBytes -= oldest[1].bytes;
    }
    this.#cache.set(key, page);
    this.#cacheBytes += page.bytes;
  }
  async pages(path: string, signal: AbortSignal, budget: ReadBudget): Promise<Page[]> {
    const result: Page[] = [];
    let endpoint: string | undefined = path;
    for (let count = 0; endpoint && count < 20; count++) {
      const page = await this.request(endpoint, signal);
      budget.add(page.bytes);
      result.push(page);
      endpoint = this.#next(page.headers.link, path);
    }
    if (endpoint) throw new ForgeError("limit");
    return result;
  }
  #next(link: string | undefined, path: string): string | undefined {
    const match = link
      ?.split(",")
      .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part))
      .find(Boolean);
    if (!match?.[1]) return undefined;
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      throw new ForgeError("invalid_data");
    }
    const apiHost = this.#host === "github.com" ? "api.github.com" : this.#host;
    const prefix = this.#host === "github.com" ? "/" : "/api/v3/";
    if (
      url.protocol !== "https:" ||
      url.host !== apiHost ||
      url.username ||
      url.password ||
      url.pathname !== `${prefix}${path.split("?")[0]}`
    )
      throw new ForgeError("invalid_data");
    return `${url.pathname.slice(prefix.length)}${url.search}`;
  }
  async log(jobPath: string, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
    const result = await this.#runner({
      command: this.#command,
      args: ["api", jobPath, "--hostname", this.#host, "--method", "GET"],
      signal,
      mode: "tail",
    });
    if (result.code !== 0) throw new ForgeError("cli");
    return { text: result.stdout, truncated: result.truncated };
  }
  async autoMerge(
    repo: string,
    number: number,
    sha: string,
    method: "merge" | "squash" | "rebase",
    signal: AbortSignal,
  ): Promise<void> {
    const dispatch = new MutationDispatch();
    try {
      const result = await this.#runner({
        command: this.#command,
        args: [
          "pr",
          "merge",
          String(number),
          "--repo",
          repo,
          "--auto",
          `--${method}`,
          "--match-head-commit",
          sha,
        ],
        signal,
        mode: "json",
        dispatch,
      });
      if (result.code !== 0) throw new ForgeError("cli");
      if (result.identityChanged) throw new ForgeMutationOutcome({ number });
    } catch (error) {
      throw dispatch.failure(error);
    }
    this.#cache.clear();
    this.#cacheBytes = 0;
  }
}
