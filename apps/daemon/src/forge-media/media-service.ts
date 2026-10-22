import { ForgeError, mediaKey, type RenderedMedia } from "@ace/forge";
import {
  forgeMediaMaxBytes,
  type ForgeMediaRequest,
  type ForgeMediaResult,
  type ForgeMediaUnavailable,
} from "@ace/protocol";
import type { ForgeMediaCache } from "./media-cache.ts";
import { fetchMedia, mediaHostAllowed, type FetchedMedia } from "./media-fetch.ts";

/*
 * Resolves media URLs from forge text to bytes in the daemon's cache (ADR 0096). A URL whose
 * media is cached answers at once and asks the forge nothing. The rest are rendered by the
 * forge in one request, fetched (a few at a time) and kept. A signed URL that stopped working
 * (they last minutes) is rendered once more and fetched again. Answers that will not change
 * soon (not found, not media, too large, a link that isn't a video) are remembered for a while;
 * passing failures only briefly, so a person scrolling past a broken image doesn't refetch it
 * on every render and a network blip doesn't stick.
 */

export type MediaRender = (
  items: readonly ForgeMediaRequest[],
  signal: AbortSignal,
) => Promise<RenderedMedia[]>;

export interface ForgeMediaServiceOptions {
  cache: ForgeMediaCache;
  now(): number;
  /** One file into `temporary`; injected so tests can stand in for the media hosts. */
  fetch?(url: string, temporary: string, signal: AbortSignal): Promise<FetchedMedia>;
  /** Fetches at once; more wait their turn. */
  concurrency?: number;
  /** How long a settled miss is remembered, and a passing failure. */
  missMs?: number;
  failureMs?: number;
}

type Remembered = { result: ForgeMediaResult; until: number };
const unavailable = (reason: ForgeMediaUnavailable): ForgeMediaResult => ({
  state: "unavailable",
  reason,
});
const missEntries = 2048;
const settled = new Set<string>(["none", "not_found", "unsupported", "too_large"]);

function forgeFailure(error: unknown): ForgeMediaUnavailable {
  if (!(error instanceof ForgeError)) return "failed";
  if (error.kind === "forbidden") return "forbidden";
  if (error.kind === "offline") return "offline";
  if (error.kind === "rate_limit") return "rate_limited";
  if (error.kind === "not_found") return "not_found";
  return "failed";
}

export class ForgeMediaService {
  private readonly options: ForgeMediaServiceOptions;
  /** Remembered misses, oldest first, at most `missEntries`. */
  private readonly misses = new Map<string, Remembered>();
  private readonly flying = new Map<string, Promise<ForgeMediaResult>>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  constructor(options: ForgeMediaServiceOptions) {
    this.options = options;
  }

  /** One result per item, in order. `host` is the forge's host; `render` asks it to render. */
  async resolve(
    host: string,
    render: MediaRender,
    items: readonly ForgeMediaRequest[],
    signal: AbortSignal,
  ): Promise<ForgeMediaResult[]> {
    const now = this.options.now();
    const results: (ForgeMediaResult | Promise<ForgeMediaResult>)[] = [];
    const wanted: { index: number; item: ForgeMediaRequest; key: string; slot: string }[] = [];
    for (const [index, item] of items.entries()) {
      const key = mediaKey(item.url);
      if (!key) {
        results[index] = unavailable("not_found");
        continue;
      }
      const slot = `${item.role}|${key}`;
      const cached = this.options.cache.lookup(key, now);
      const remembered = this.misses.get(slot);
      const flying = this.flying.get(slot);
      if (cached?.fresh) results[index] = { state: "ready", ...cached.media };
      else if (remembered && remembered.until > now) results[index] = remembered.result;
      else if (flying) results[index] = flying;
      else wanted.push({ index, item, key, slot });
    }
    if (wanted.length) {
      const batch = this.batch(host, render, wanted, signal);
      for (const [position, entry] of wanted.entries()) {
        const result = batch.then((all) => all[position] ?? unavailable("failed"));
        this.flying.set(entry.slot, result);
        void result.finally(() => {
          if (this.flying.get(entry.slot) === result) this.flying.delete(entry.slot);
        });
        results[entry.index] = result;
      }
    }
    return Promise.all(results);
  }

  private async batch(
    host: string,
    render: MediaRender,
    wanted: { item: ForgeMediaRequest; key: string; slot: string }[],
    signal: AbortSignal,
  ): Promise<ForgeMediaResult[]> {
    let rendered: RenderedMedia[];
    try {
      rendered = await render(
        wanted.map((entry) => entry.item),
        signal,
      );
    } catch (error) {
      const result = unavailable(forgeFailure(error));
      return wanted.map((entry) => {
        this.remember(entry.slot, result);
        const stale = this.options.cache.lookup(entry.key, this.options.now());
        return stale ? { state: "ready" as const, ...stale.media } : result;
      });
    }
    return Promise.all(
      wanted.map(async (entry, index) => {
        const result = await this.obtain(host, render, entry, rendered[index] ?? null, signal);
        if (result.state === "ready") return result;
        this.remember(entry.slot, result);
        // Bytes past their week still stand for a URL that can't be fetched again now.
        const stale = this.options.cache.lookup(entry.key, this.options.now());
        return stale ? { state: "ready" as const, ...stale.media } : result;
      }),
    );
  }

  /** Fetch rendered media into the cache; a signed URL that fails is rendered once more. */
  private async obtain(
    host: string,
    render: MediaRender,
    entry: { item: ForgeMediaRequest; key: string },
    rendered: RenderedMedia,
    signal: AbortSignal,
  ): Promise<ForgeMediaResult> {
    if (!rendered) return entry.item.role === "link" ? { state: "none" } : unavailable("not_found");
    let fetched = await this.fetchOne(host, entry.key, rendered.url, signal);
    if (fetched.kind === "missing" && rendered.expiresAt !== undefined) {
      // The signed URL lapsed between rendering and fetching (or was refused): render again.
      let again: RenderedMedia | undefined;
      try {
        [again] = await render([entry.item], signal);
      } catch (error) {
        return unavailable(forgeFailure(error));
      }
      if (again) fetched = await this.fetchOne(host, entry.key, again.url, signal);
    }
    if (fetched.kind === "ok") return fetched.result;
    if (fetched.kind === "too_large") return unavailable("too_large");
    if (fetched.kind === "unsupported") return unavailable("unsupported");
    if (fetched.kind === "missing") return unavailable("not_found");
    if (fetched.kind === "refused") return unavailable("forbidden");
    return unavailable("failed");
  }

  private async fetchOne(
    host: string,
    key: string,
    url: string,
    signal: AbortSignal,
  ): Promise<{ kind: "ok"; result: ForgeMediaResult } | Exclude<FetchedMedia, { kind: "ok" }>> {
    if (!mediaHostAllowed(url, host)) return { kind: "refused" };
    await this.acquire();
    try {
      signal.throwIfAborted();
      const cache = this.options.cache;
      const temporary = cache.temporary();
      const fetched = await (this.options.fetch
        ? this.options.fetch(url, temporary, signal)
        : fetchMedia(url, temporary, { maxBytes: forgeMediaMaxBytes }));
      if (fetched.kind !== "ok") return fetched;
      const media = {
        sha256: fetched.sha256,
        mimeType: fetched.media.mimeType,
        kind: fetched.media.kind,
        bytes: fetched.bytes,
        ...fetched.dimensions,
      };
      await cache.adopt(key, temporary, media, this.options.now());
      return { kind: "ok", result: { state: "ready", ...media } };
    } catch {
      return { kind: "failed" };
    } finally {
      this.release();
    }
  }

  private remember(slot: string, result: ForgeMediaResult): void {
    const lasting =
      result.state === "none" || (result.state === "unavailable" && settled.has(result.reason));
    const ms = lasting ? (this.options.missMs ?? 10 * 60_000) : (this.options.failureMs ?? 15_000);
    this.misses.delete(slot);
    this.misses.set(slot, { result, until: this.options.now() + ms });
    for (const oldest of this.misses.keys()) {
      if (this.misses.size <= missEntries) break;
      this.misses.delete(oldest);
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < (this.options.concurrency ?? 3)) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
