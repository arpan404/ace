import type { ClientApi } from "@ace/client";
import {
  WorkspaceId,
  forgeMediaBatch,
  forgeMediaMaxBytes,
  type ForgeMediaRequest,
  type ForgeMediaResult,
  type ForgeRepository,
} from "@ace/protocol";
import { LruCache } from "@ace/ui-core";
import { ByteLoads, type ImageLease } from "@/components/byte-loads.ts";
import { readForge } from "@/lib/forge-read.ts";

/*
 * Media in forge text, for one connection (ADR 0096). URLs a page shows are resolved together:
 * those asked for in the same moment go to the daemon in one request per project and
 * repository, 32 at a time. Answers are kept for the session (an answer that may change soon
 * only briefly); bytes are then read by hash through the project's download, a few at a time,
 * and kept in a small LRU so a row scrolled away and back shows at once.
 */

export interface ForgeScope {
  workspaceId: string;
  repository: ForgeRepository;
}
export type ReadyMedia = Extract<ForgeMediaResult, { state: "ready" }>;

const settledMisses = new Set(["not_found", "unsupported", "too_large"]);
type Kept = { result: ForgeMediaResult; until: number };
type Waiting = { item: ForgeMediaRequest; settle: ((result: ForgeMediaResult) => void)[] };

const scopeKey = (scope: ForgeScope) =>
  `${scope.workspaceId}\u0000${scope.repository.host}/${scope.repository.owner}/${scope.repository.name}`;

/** What a browser can play: QuickTime files are usually H.264 that plays as MP4. */
function playableType(mimeType: string): string {
  if (mimeType !== "video/quicktime" || typeof document === "undefined") return mimeType;
  return document.createElement("video").canPlayType("video/quicktime") ? mimeType : "video/mp4";
}

export class ForgeMediaLoads {
  private client: ClientApi;
  private schedule: (delay: number, callback: () => void) => () => void;
  private now: () => number;
  private kept = new LruCache<string, Kept>({ maxEntries: 2048 });
  private waiting = new Map<string, { scope: ForgeScope; items: Map<string, Waiting> }>();
  private flushing: (() => void) | undefined;
  private bytes: ByteLoads<{ scope: ForgeScope; media: ReadyMedia }>;
  constructor(
    client: ClientApi,
    schedule: (delay: number, callback: () => void) => () => void,
    now: () => number,
  ) {
    this.client = client;
    this.schedule = schedule;
    this.now = now;
    this.bytes = new ByteLoads(client, schedule, {
      key: ({ media }) => media.sha256,
      weight: ({ media }) => media.bytes,
      concurrency: 3,
      budget: forgeMediaMaxBytes,
      kept: { maxEntries: 64, maxWeight: 96 * 1024 * 1024 },
      read: ({ scope, media }, signal) => this.download(scope, media, signal),
    });
  }

  /** The answer already known for `item`, if any: a page draws it on its first render. */
  known(scope: ForgeScope, item: ForgeMediaRequest): ForgeMediaResult | undefined {
    const kept = this.kept.get(`${scopeKey(scope)}\u0000${item.role}\u0000${item.url}`);
    return kept && kept.until > this.now() ? kept.result : undefined;
  }

  resolve(scope: ForgeScope, item: ForgeMediaRequest): Promise<ForgeMediaResult> {
    const known = this.known(scope, item);
    if (known) return Promise.resolve(known);
    const group = scopeKey(scope);
    let batch = this.waiting.get(group);
    if (!batch) {
      batch = { scope, items: new Map() };
      this.waiting.set(group, batch);
    }
    const itemKey = `${item.role}\u0000${item.url}`;
    let entry = batch.items.get(itemKey);
    if (!entry) {
      entry = { item, settle: [] };
      batch.items.set(itemKey, entry);
    }
    const waiting = entry;
    // Everything asked for while this page renders goes in one request.
    this.flushing ??= this.schedule(0, () => this.flush());
    return new Promise((resolve) => waiting.settle.push(resolve));
  }

  cachedBytes(scope: ForgeScope, media: ReadyMedia): Blob | undefined {
    return this.bytes.cached({ scope, media });
  }
  acquireBytes(scope: ForgeScope, media: ReadyMedia): ImageLease {
    return this.bytes.acquire({ scope, media });
  }
  evictBytes(scope: ForgeScope, media: ReadyMedia): void {
    this.bytes.evict({ scope, media });
  }

  private flush(): void {
    this.flushing = undefined;
    const batches = [...this.waiting.values()];
    this.waiting.clear();
    for (const { scope, items } of batches) {
      const entries = [...items.values()];
      for (let at = 0; at < entries.length; at += forgeMediaBatch)
        void this.ask(scope, entries.slice(at, at + forgeMediaBatch));
    }
  }

  private async ask(scope: ForgeScope, entries: Waiting[]): Promise<void> {
    let results: readonly ForgeMediaResult[];
    try {
      const reply = await readForge(
        this.client,
        {
          op: "forge.media.resolve",
          workspaceId: scope.workspaceId,
          repository: scope.repository,
          items: entries.map((entry) => entry.item),
        },
        new AbortController().signal,
      );
      results = reply.resource === "media" ? reply.items : [];
    } catch {
      results = [];
    }
    for (const [index, entry] of entries.entries()) {
      const result = results[index] ?? { state: "unavailable", reason: "failed" };
      const lasting =
        result.state !== "unavailable" || settledMisses.has(result.reason) ? 30 * 60_000 : 15_000;
      this.kept.set(`${scopeKey(scope)}\u0000${entry.item.role}\u0000${entry.item.url}`, {
        result,
        until: this.now() + lasting,
      });
      for (const settle of entry.settle) settle(result);
    }
  }

  private async download(scope: ForgeScope, media: ReadyMedia, signal: AbortSignal) {
    const bytes = new Uint8Array(media.bytes);
    let offset = 0;
    for await (const chunk of this.client.downloadFile(
      {
        workspaceId: WorkspaceId.parse(scope.workspaceId),
        op: "forge.media.download",
        sha256: media.sha256,
        offset: 0,
      },
      { signal },
    )) {
      if (offset + chunk.length > bytes.length) throw new Error("Forge media is larger than said");
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== bytes.length) throw new Error("Forge media ended early");
    return new Blob([bytes], { type: playableType(media.mimeType) });
  }
}

const loads = new WeakMap<ClientApi, ForgeMediaLoads>();
/** The connection's forge media loads, made once. */
export function forgeMediaLoads(client: ClientApi): ForgeMediaLoads {
  let found = loads.get(client);
  if (!found) {
    found = new ForgeMediaLoads(
      client,
      (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      () => Date.now(),
    );
    loads.set(client, found);
  }
  return found;
}
