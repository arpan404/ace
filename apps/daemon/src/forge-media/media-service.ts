import { ForgeError, mediaKey, type RenderedMedia } from "@ace/forge";
import {
  forgeMediaMaxBytes,
  type ForgeMediaRequest,
  type ForgeMediaResult,
  type ForgeMediaUnavailable,
} from "@ace/protocol";
import type { ForgeMediaCache } from "./media-cache.ts";
import type { ForgeMediaGrants } from "./media-grants.ts";
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
  /** How long a settled miss is remembered, and a passing failure at first. */
  missMs?: number;
  failureMs?: number;
  /** Records which project may download what it resolved. */
  grants?: ForgeMediaGrants;
}

type Remembered = { result: ForgeMediaResult; until: number; failures: number };
type Wanted = { index: number; item: ForgeMediaRequest; key: string; slot: string };

/** Who asks: the forge host, the repository whose text it is, and the project asking. */
export interface MediaScope {
  host: string;
  /** `host/owner/name`. */
  repository: string;
  workspaceId: string;
}
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

  /**
   * One result per item, in order. `scope` names the forge host, the repository whose text it
   * is (`host/owner/name`, which keys the cache) and the project asking (granted what it gets);
   * `render` asks the forge to render. The batch runs on its own: one requester going away
   * never fails it for others waiting on the same media.
   */
  async resolve(
    scope: MediaScope,
    render: MediaRender,
    items: readonly ForgeMediaRequest[],
  ): Promise<ForgeMediaResult[]> {
    const now = this.options.now();
    const results: (ForgeMediaResult | Promise<ForgeMediaResult>)[] = [];
    const wanted: Wanted[] = [];
    const refresh: Wanted[] = [];
    for (const [index, item] of items.entries()) {
      const media = mediaKey(item.url);
      if (!media) {
        results[index] = unavailable("not_found");
        continue;
      }
      // Kept per repository: what one repository's text resolved never answers another's.
      const key = `${scope.repository} ${media}`;
      const slot = `${item.role}|${key}`;
      const cached = this.options.cache.lookup(key, now);
      const remembered = this.misses.get(slot);
      const flying = this.flying.get(slot);
      if (cached) {
        // Cached bytes answer at once, fresh or not; old ones are refreshed behind them.
        results[index] = this.granted(scope, { state: "ready", ...cached.media });
        if (!cached.fresh && !flying && !(remembered && remembered.until > now))
          refresh.push({ index, item, key, slot });
      } else if (remembered && remembered.until > now) results[index] = remembered.result;
      else if (flying) results[index] = flying.then((result) => this.granted(scope, result));
      else wanted.push({ index, item, key, slot });
    }
    const batched = [...wanted, ...refresh];
    if (batched.length) {
      const batch = this.batch(scope.host, render, batched);
      for (const [position, entry] of batched.entries()) {
        const result = batch.then((all) => all[position] ?? unavailable("failed"));
        this.flying.set(entry.slot, result);
        void result.finally(() => {
          if (this.flying.get(entry.slot) === result) this.flying.delete(entry.slot);
        });
        if (position < wanted.length)
          results[entry.index] = result.then((answer) => this.granted(scope, answer));
      }
    }
    return Promise.all(results);
  }

  private granted(scope: MediaScope, result: ForgeMediaResult): ForgeMediaResult {
    if (result.state === "ready") this.options.grants?.grant(scope.workspaceId, result.sha256);
    return result;
  }

  private async batch(host: string, render: MediaRender, wanted: Wanted[]) {
    const signal = new AbortController().signal;
    let rendered: RenderedMedia[];
    try {
      rendered = await render(
        wanted.map((entry) => entry.item),
        signal,
      );
    } catch (error) {
      const result = unavailable(forgeFailure(error));
      return wanted.map((entry) => this.settle(entry, result));
    }
    return Promise.all(
      wanted.map(async (entry, index) =>
        this.settle(entry, await this.obtain(host, render, entry, rendered[index] ?? null, signal)),
      ),
    );
  }

  /** A batch's answer for one item: kept bytes beat a failure to fetch them again. */
  private settle(entry: Wanted, result: ForgeMediaResult): ForgeMediaResult {
    if (result.state === "ready") {
      this.misses.delete(entry.slot);
      return result;
    }
    this.remember(entry.slot, result);
    const stale = this.options.cache.lookup(entry.key, this.options.now());
    return stale ? { state: "ready", ...stale.media } : result;
  }

  /** Fetch rendered media into the cache; a signed URL that fails is rendered once more. */
  private async obtain(
    host: string,
    render: MediaRender,
    entry: Wanted,
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
        : fetchMedia(url, temporary, { maxBytes: forgeMediaMaxBytes, forgeHost: host }));
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

  /**
   * Remember a miss. A settled one (not found, not media, too large, not a video) for a while;
   * a passing failure briefly at first, then longer each time it fails again (15 s doubling to
   * 30 minutes), so a large video that a slow link can't finish isn't fetched over and over.
   */
  private remember(slot: string, result: ForgeMediaResult): void {
    const lasting =
      result.state === "none" || (result.state === "unavailable" && settled.has(result.reason));
    const failures = lasting ? 0 : (this.misses.get(slot)?.failures ?? 0) + 1;
    const ms = lasting
      ? (this.options.missMs ?? 10 * 60_000)
      : Math.min((this.options.failureMs ?? 15_000) * 2 ** (failures - 1), 30 * 60_000);
    this.misses.delete(slot);
    this.misses.set(slot, { result, until: this.options.now() + ms, failures });
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
