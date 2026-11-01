import { readFile, writeFile, rename } from "node:fs/promises";
import { z } from "zod";
import { PriceTable, type UsageSettings } from "./settings.ts";
import { parseLiteLLM, priceUrl } from "./litellm.ts";

const hour = 3_600_000;
const Cache = z.object({
  prices: PriceTable.optional(),
  checked: z.number().default(0),
  extra: z.number().default(0),
  retry: z.number().default(0),
  failures: z.number().default(0),
  etag: z.string().optional(),
  modified: z.string().optional(),
});
/** Lives only in the usage worker. Scheduling metadata survives idle worker retirement. */
export class PriceRefresh {
  private cache = Cache.parse({});
  private pending: Promise<void> | undefined;
  private closed = false;
  constructor(
    privatePath: string,
    privateSettings: UsageSettings,
    privateNow: () => number,
    privateFetch: typeof fetch,
    privateApply: (prices: PriceTable) => void,
    privateLog: () => void,
  ) {
    this.path = privatePath;
    this.settings = privateSettings;
    this.now = privateNow;
    this.fetch = privateFetch;
    this.apply = privateApply;
    this.log = privateLog;
  }
  private readonly path: string;
  private readonly settings: UsageSettings;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly apply: (prices: PriceTable) => void;
  private readonly log: () => void;
  async load(): Promise<void> {
    if (!this.settings.fetchPrices) return;
    try {
      this.cache = Cache.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      /* First run, missing or damaged cache uses the bundle. */
    }
    if (this.cache.prices) this.apply(this.cache.prices);
  }
  refresh(unknownModel = false): Promise<void> {
    if (this.closed || !this.settings.fetchPrices) return Promise.resolve();
    if (this.pending) return this.pending;
    const now = this.now();
    if (now < this.cache.retry) return Promise.resolve();
    const daily = !this.cache.checked || now - this.cache.checked >= 24 * hour;
    const extra = unknownModel && (!this.cache.extra || now - this.cache.extra >= hour);
    if (!daily && !extra) return Promise.resolve();
    this.pending = this.download(daily, now).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async save(): Promise<void> {
    await writeFile(`${this.path}.tmp`, JSON.stringify(this.cache), { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
  private async download(daily: boolean, now: number): Promise<void> {
    if (daily) this.cache.checked = now;
    // A daily request also consumes this hour's discovery allowance.
    this.cache.extra = now;
    try {
      await this.save();
      const headers: Record<string, string> = {};
      if (this.cache.etag) headers["If-None-Match"] = this.cache.etag;
      if (this.cache.modified) headers["If-Modified-Since"] = this.cache.modified;
      const response = await this.fetch(priceUrl, {
        headers,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 304) {
        if (!response.ok) throw new Error("Price request failed");
        // Bound both streaming bodies and advertised sizes before JSON parsing.
        if (Number(response.headers.get("content-length")) > 16 * 1024 * 1024)
          throw new Error("Price list too large");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Missing price body");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 16 * 1024 * 1024) throw new Error("Price list too large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const prices = PriceTable.parse(
          parseLiteLLM(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
            new Date(now).toISOString().slice(0, 10),
          ),
        );
        const previous = this.cache;
        this.cache = {
          ...this.cache,
          prices,
          etag: response.headers.get("etag") ?? undefined,
          modified: response.headers.get("last-modified") ?? undefined,
        };
        try {
          await this.save();
        } catch (error) {
          this.cache = previous;
          throw error;
        }
        if (!this.closed) this.apply(prices);
      } else if (!this.cache.prices) throw new Error("No cached list for 304");
      this.cache.failures = 0;
      this.cache.retry = 0;
      await this.save();
    } catch {
      this.cache.failures++;
      this.cache.retry =
        now + Math.min(24 * hour, hour * 2 ** Math.min(5, this.cache.failures - 1));
      try {
        await this.save();
      } catch {
        /* Keep usable in-memory prices. */
      }
      this.log();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
  }
}
