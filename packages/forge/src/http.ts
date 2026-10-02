import { z } from "zod";
import { ForgeError } from "./errors.ts";
import { redactData } from "./redact.ts";
import type { CommandRunner } from "./command.ts";

import { ReadBudget } from "./read-budget.ts";

const envelope = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
});
type Page = { body: unknown; headers: Record<string, string>; bytes: number };
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
    const cached = method === "GET" ? this.#cache.get(path) : undefined;
    if (cached?.headers.etag) args.push("--header", `If-None-Match: ${cached.headers.etag}`);
    const input = body === undefined ? undefined : JSON.stringify(body);
    if (input !== undefined) args.push("--input", "-");
    const output = await this.#runner({
      command: this.#command,
      args,
      signal,
      mode: "json",
      ...(input === undefined ? {} : { input }),
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
      this.#cache.delete(path);
      this.#cache.set(path, cached);
      return cached;
    }
    if (
      code === 429 ||
      (code === 403 &&
        (headers["x-ratelimit-remaining"] === "0" ||
          headers["retry-after"] !== undefined ||
          /secondary rate limit|rate limit exceeded|abuse detection/i.test(rateMessage)))
    ) {
      const seconds = Number(headers["retry-after"]);
      const reset = Number(headers["x-ratelimit-reset"]) * 1_000;
      const retryAt =
        Number.isFinite(seconds) && seconds >= 0
          ? this.#now() + seconds * 1_000
          : Number.isFinite(reset) && reset > this.#now()
            ? reset
            : this.#now() + 60_000;
      throw new ForgeError("rate_limit", retryAt);
    }
    if (code === 404) throw new ForgeError("not_found");
    if (code === 401 || code === 403) throw new ForgeError("forbidden");
    if (code === 409 || code === 422) throw new ForgeError("conflict");
    if (code < 200 || code >= 300 || output.code !== 0) throw new ForgeError("cli");
    let data: unknown;
    try {
      data = text.trim() ? redactData(JSON.parse(text)) : null;
    } catch {
      throw new ForgeError("invalid_data");
    }
    const page = {
      bytes: Buffer.byteLength(text),
      body: data,
      headers: {
        ...(headers.etag && /^[\x20-\x7e]{1,512}$/.test(headers.etag)
          ? { etag: headers.etag }
          : {}),
        ...(headers.link ? { link: headers.link } : {}),
      },
    };
    if (method !== "GET" && path !== "graphql") {
      this.#cache.clear();
      this.#cacheBytes = 0;
    } else if (method === "GET" && headers.etag && text.length <= 1_048_576) {
      if (cached) {
        this.#cache.delete(path);
        this.#cacheBytes -= cached.bytes;
      }
      const bytes = Buffer.byteLength(text);
      while (this.#cache.size >= 128 || this.#cacheBytes + bytes > 8_388_608) {
        const oldest = this.#cache.entries().next().value;
        if (!oldest) break;
        this.#cache.delete(oldest[0]);
        this.#cacheBytes -= oldest[1].bytes;
      }
      this.#cache.set(path, { ...page, bytes });
      this.#cacheBytes += bytes;
    }
    return page;
  }
  async list<T>(
    path: string,
    schema: z.ZodType<T[]>,
    signal: AbortSignal,
    budget: ReadBudget,
  ): Promise<T[]> {
    const result: T[] = [];
    let endpoint: string | undefined = path;
    for (let count = 0; endpoint && count < 20; count++) {
      const page = await this.request(endpoint, signal);
      budget.add(page.bytes);
      const parsed = schema.safeParse(page.body);
      if (!parsed.success) throw new ForgeError("invalid_data");
      result.push(...parsed.data);
      if (result.length > 2_000) throw new ForgeError("limit");
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
    });
    if (result.code !== 0) throw new ForgeError("cli");
    this.#cache.clear();
    this.#cacheBytes = 0;
  }
}
