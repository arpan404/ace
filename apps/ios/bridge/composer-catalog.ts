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
  /** Re-reads asked while discovery is still running. */
  retries: number;
}
const quiet = { timeoutMs: 15_000 };

export interface CatalogPorts {
  owner: Pick<ClientCore, "request">;
  now(): number;
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
    const known = this.#catalogs.get(target.key);
    if (known?.reading) return known.reading;
    const catalog: Catalog = known ?? {
      entries: [],
      stale: false,
      failed: false,
      at: 0,
      reading: undefined,
      retries: 0,
    };
    this.#catalogs.set(target.key, catalog);
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

  /**
   * Read the target's catalog, and while the answer is still stale read it again after each
   * `pause`, up to `staleRetries` times. A failed read stops the retries.
   */
  async settle(target: ReadTarget, pause: (delay: number) => Promise<void>): Promise<Catalog> {
    await this.read(target);
    for (let tries = 0; tries < staleRetries; tries++) {
      const known = this.#catalogs.get(target.key);
      if (!known?.stale || known.failed) break;
      await pause(staleRetry);
      await this.read(target);
    }
    const catalog = this.#catalogs.get(target.key);
    if (!catalog) throw new Error("catalog was never read");
    return catalog;
  }
}
