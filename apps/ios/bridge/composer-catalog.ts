import type { ClientCore } from "@ace/client";
import { ThreadId, WorkspaceId, type CatalogEntry, type ProviderKind } from "@ace/protocol";

/*
 * The phone's catalog reads: the composer's (`composer-suggest.ts`), one per thread or per New
 * thread project and agent, kept so `/` and + open on the last answer while it is read again;
 * and the Skills and commands pages' (`catalog-page.ts`). A transient empty answer while
 * discovery runs never replaces entries already shown.
 */

export type Target =
  | { type: "thread"; key: string; threadId: string; workspaceId: string; provider: ProviderKind }
  | { type: "draft"; key: string; workspaceId: string; provider: ProviderKind };
/** What a read needs: a thread, a New thread draft, or a project and coding agent. */
export type ReadTarget =
  | { type: "thread"; key: string; threadId: string }
  | { type: "draft"; key: string; workspaceId: string; provider: ProviderKind }
  | { type: "workspace"; key: string; workspaceId: string; provider: ProviderKind };
/**
 * The daemon answers from its cache (stale) while discovery runs and pushes fresh entries only
 * to subscribers, so a stale answer is read again this often, this many times.
 */
export const staleRetry = 1_500;
export const staleRetries = 6;
export interface Catalog {
  entries: readonly CatalogEntry[];
  stale: boolean;
  failed: boolean;
  at: number;
  reading: Promise<void> | undefined;
  /** The retry loop running for this target, which every caller joins (`settle`). */
  settling: Promise<void> | undefined;
  /** Re-reads made by that loop while discovery is still running. */
  retries: number;
  /** Told after each of the loop's reads, while their caller waits on it. */
  watchers: Set<() => void>;
}
const quiet = { timeoutMs: 15_000 };

export interface CatalogPorts {
  owner: Pick<ClientCore, "request">;
  now(): number;
  /** The pause between a stale answer and the next read. */
  schedule(delay: number, run: () => void): () => void;
  draft: { draftScope(workspaceId: string): Promise<string> };
}

export class CatalogReads {
  readonly #ports: CatalogPorts;
  readonly #catalogs = new Map<string, Catalog>();
  constructor(ports: CatalogPorts) {
    this.#ports = ports;
  }
  get(key: string): Catalog | undefined {
    return this.#catalogs.get(key);
  }

  /** Read the target's catalog; one read at a time per target. */
  read(target: ReadTarget): Promise<void> {
    const catalog = this.#entry(target.key);
    if (catalog.reading) return catalog.reading;
    const read = async () => {
      try {
        const reply =
          target.type === "thread"
            ? await this.#ports.owner.request(
                { type: "catalog.list", threadId: ThreadId.parse(target.threadId), limit: 512 },
                quiet,
              )
            : target.type === "workspace"
              ? await this.#ports.owner.request(
                  {
                    type: "catalog.list",
                    workspace: {
                      workspaceId: WorkspaceId.parse(target.workspaceId),
                      provider: target.provider,
                    },
                    limit: 512,
                  },
                  quiet,
                )
              : await this.#ports.owner.request(
                  {
                    type: "catalog.list",
                    draft: {
                      draftId: await this.#ports.draft.draftScope(target.workspaceId),
                      workspaceId: WorkspaceId.parse(target.workspaceId),
                      provider: target.provider,
                    },
                    limit: 512,
                  },
                  quiet,
                );
        // A transient empty read while discovery runs keeps the entries already shown.
        if (!(reply.stale && !reply.entries.length && catalog.entries.length))
          catalog.entries = reply.entries;
        catalog.stale = reply.stale;
        catalog.failed = false;
        if (!reply.stale) catalog.retries = 0;
        catalog.at = this.#ports.now();
      } catch {
        catalog.failed = true;
      } finally {
        catalog.reading = undefined;
      }
    };
    catalog.reading = read();
    return catalog.reading;
  }

  #entry(key: string): Catalog {
    const known = this.#catalogs.get(key);
    if (known) return known;
    const catalog: Catalog = {
      entries: [],
      stale: false,
      failed: false,
      at: 0,
      reading: undefined,
      settling: undefined,
      retries: 0,
      watchers: new Set(),
    };
    this.#catalogs.set(key, catalog);
    return catalog;
  }

  /**
   * Read the target's catalog, and while the answer is still stale read it again every
   * `staleRetry`, up to `staleRetries` times; a failed read stops the retries. One loop runs per
   * target: a caller arriving while it runs joins it, and `onRead` hears each read from then on.
   */
  async settle(target: ReadTarget, onRead?: () => void): Promise<Catalog> {
    const catalog = this.#entry(target.key);
    if (onRead) catalog.watchers.add(onRead);
    try {
      catalog.settling ??= this.#retry(target, catalog);
      await catalog.settling;
    } finally {
      if (onRead) catalog.watchers.delete(onRead);
    }
    return catalog;
  }

  async #retry(target: ReadTarget, catalog: Catalog): Promise<void> {
    const told = () => {
      for (const watcher of catalog.watchers) watcher();
    };
    try {
      catalog.retries = 0;
      await this.read(target);
      told();
      while (catalog.stale && !catalog.failed && catalog.retries < staleRetries) {
        catalog.retries++;
        await new Promise<void>((resolve) => this.#ports.schedule(staleRetry, resolve));
        await this.read(target);
        told();
      }
    } finally {
      catalog.settling = undefined;
    }
  }
}
