import { readFile, writeFile, rename } from "node:fs/promises";
import { z } from "zod";
import { ModelPrice, type PriceTable, type UsageSettings } from "./settings.ts";
import { parseLiteLLM, priceUrl } from "./litellm.ts";

export const PRICE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const hour = 3_600_000;
const Cache = z.object({
  models: z.record(
    z.string(),
    z.object({
      price: ModelPrice,
      asOf: z.iso.date(),
      fetchedAt: z.number().nonnegative(),
      etag: z.string().optional(),
      modified: z.string().optional(),
    }),
  ),
});
const Attempts = z.object({ next: z.number().default(0), failures: z.number().default(0) });
async function atomicWrite(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** On-demand worker-only cache. Failed attempts change only the throttle sidecar. */
export class PriceRefresh {
  private cache = Cache.parse({ models: {} });
  private attempts = Attempts.parse({});
  private pending: Promise<void> | undefined;
  private closed = false;
  private readonly path: string;
  private readonly settings: UsageSettings;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly apply: (prices: PriceTable) => void;
  private readonly log: () => void;
  constructor(
    path: string,
    settings: UsageSettings,
    now: () => number,
    network: typeof fetch,
    apply: (prices: PriceTable) => void,
    log: () => void,
  ) {
    this.path = path;
    this.settings = settings;
    this.now = now;
    this.fetch = network;
    this.apply = apply;
    this.log = log;
  }
  private table(): PriceTable {
    const asOf = Object.values(this.cache.models)
      .map((entry) => entry.asOf)
      .toSorted()
      .at(-1);
    return {
      version: `litellm-${asOf ?? "empty"}`,
      asOf,
      sources: [priceUrl],
      models: Object.fromEntries(
        Object.entries(this.cache.models).map(([model, entry]) => [
          model,
          { ...entry.price, asOf: entry.asOf },
        ]),
      ),
    };
  }
  async load(): Promise<void> {
    if (!this.settings.fetchPrices) return;
    try {
      this.cache = Cache.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      /* Missing/old-format cache uses the bundled fallback without changing the file. */
    }
    try {
      this.attempts = Attempts.parse(JSON.parse(await readFile(`${this.path}.attempts`, "utf8")));
    } catch {
      /* First use has no throttle state. */
    }
    if (Object.keys(this.cache.models).length) this.apply(this.table());
  }
  /** The worker passes only models observed in usage, recent/most-used first. No timers. */
  refresh(models: readonly string[]): Promise<void> {
    if (this.closed || !this.settings.fetchPrices || !models.length) return Promise.resolve();
    if (this.pending) return this.pending;
    const now = this.now();
    const due = [...new Set(models)].filter((model) => {
      const entry = this.cache.models[model];
      return !entry || now - entry.fetchedAt >= PRICE_MAX_AGE_MS;
    });
    if (now < this.attempts.next || !due.length) return Promise.resolve();
    this.pending = this.download(due, now).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async download(models: string[], now: number): Promise<void> {
    try {
      this.attempts.next = now + hour;
      await atomicWrite(`${this.path}.attempts`, this.attempts);
      const headers: Record<string, string> = {};
      // A 304 cannot supply a newly encountered model. Fetch a body in that case.
      const first = this.cache.models[models[0] ?? ""];
      const conditional =
        first !== undefined &&
        models.every((model) => {
          const entry = this.cache.models[model];
          return (
            entry !== undefined && entry.etag === first.etag && entry.modified === first.modified
          );
        });
      if (conditional && first?.etag) headers["If-None-Match"] = first.etag;
      if (conditional && first?.modified) headers["If-Modified-Since"] = first.modified;
      const response = await this.fetch(priceUrl, {
        headers,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      });
      const next = Cache.parse(this.cache);
      if (response.status === 304) {
        if (!conditional) throw new Error("No cached prices for 304");
        for (const model of models) {
          const entry = next.models[model];
          if (entry) entry.fetchedAt = now;
        }
      } else {
        if (!response.ok) throw new Error("Price request failed");
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
        const date = new Date(now).toISOString().slice(0, 10);
        // Full JSON exists only transiently while parsing in this worker. Normalize/retain
        // only requested models; never build or persist a normalized full catalogue.
        const prices = parseLiteLLM(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          date,
          models,
        );
        if (!Object.keys(prices.models).length) {
          this.attempts.failures = 0;
          await atomicWrite(`${this.path}.attempts`, this.attempts);
          return;
        }
        for (const [model, price] of Object.entries(prices.models))
          next.models[model] = {
            price,
            asOf: date,
            fetchedAt: now,
            etag: response.headers.get("etag") ?? undefined,
            modified: response.headers.get("last-modified") ?? undefined,
          };
      }
      const validated = Cache.parse(next);
      await atomicWrite(this.path, validated);
      this.cache = validated;
      if (!this.closed) this.apply(this.table());
      this.attempts.failures = 0;
      await atomicWrite(`${this.path}.attempts`, this.attempts);
    } catch {
      this.attempts.failures++;
      this.attempts.next =
        now + Math.min(24 * hour, hour * 2 ** Math.min(5, this.attempts.failures - 1));
      try {
        await atomicWrite(`${this.path}.attempts`, this.attempts);
      } catch {
        /* Best effort throttle. */
      }
      this.log();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
  }
}
