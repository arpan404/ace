import { ProviderKind, type CatalogEntry } from "@ace/protocol";
import { z } from "zod";
import type { CatalogReads, ReadTarget } from "./composer-catalog.ts";

/*
 * The Skills and commands pages (a thread's, and Settings' Available CLI skills) read the
 * catalog through the composer's reader, so an open thread's page and its `/` list share one
 * answer. The first read answers at once; a stale one says it is refreshing, and Swift asks
 * again with `settle`, which reads again on the composer's rule until discovery ends. Only an
 * answer still stale after that is shown as cached.
 */

export const NativeCatalogRequest = z
  .object({
    type: z.literal("catalog.page"),
    threadId: z.string().min(1).max(128).optional(),
    workspace: z
      .object({ workspaceId: z.string().min(1).max(256), provider: ProviderKind })
      .optional(),
    /** Read again while the answer stays stale, and answer once it settles. */
    settle: z.boolean().default(false),
  })
  .refine((value) => (value.threadId === undefined) !== (value.workspace === undefined));
export type NativeCatalogRequest = z.input<typeof NativeCatalogRequest>;

export interface CatalogPageReply {
  entries: readonly CatalogEntry[];
  stale: boolean;
  /** Still stale on the first read: Swift asks again with `settle`. */
  refreshing: boolean;
  notice: string | null;
}
type Schedule = (delay: number, run: () => void) => () => void;

/** The web composer's words while discovery refreshes the list. */
const refreshingNotice = "Refreshing skills and commands…";
const cachedNotice = "Showing cached entries. Pull to refresh to read them again.";

export class CatalogPage {
  readonly #reads: CatalogReads;
  readonly #schedule: Schedule;
  constructor(reads: CatalogReads, schedule: Schedule) {
    this.#reads = reads;
    this.#schedule = schedule;
  }

  async answer(raw: NativeCatalogRequest, signal: AbortSignal): Promise<CatalogPageReply> {
    const request = NativeCatalogRequest.parse(raw);
    const { threadId, workspace } = request;
    const target: ReadTarget | undefined = workspace
      ? { type: "workspace", key: workspaceKey(workspace), ...workspace }
      : threadId
        ? { type: "thread", key: `thread:${threadId}`, threadId }
        : undefined;
    if (!target) throw new Error("A catalog page reads a thread or a project");
    if (!request.settle) await this.#reads.read(target);
    const catalog = request.settle
      ? await this.#reads.settle(target, (delay) => this.#pause(delay, signal))
      : this.#reads.get(target.key);
    if (!catalog || (catalog.failed && !catalog.entries.length))
      throw new Error("The catalog couldn't be read");
    const refreshing = catalog.stale && !request.settle;
    return {
      entries: catalog.entries,
      stale: catalog.stale,
      refreshing,
      notice: refreshing ? refreshingNotice : catalog.stale ? cachedNotice : null,
    };
  }

  #pause(delay: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("The page closed"));
      const stop = () => {
        cancel();
        reject(new Error("The page closed"));
      };
      const cancel = this.#schedule(delay, () => {
        signal.removeEventListener("abort", stop);
        resolve();
      });
      signal.addEventListener("abort", stop, { once: true });
    });
  }
}

/** Kept apart from the composer's draft keys: a project read has no New thread draft. */
function workspaceKey(workspace: { workspaceId: string; provider: string }): string {
  return `workspace:${workspace.workspaceId}:${workspace.provider}`;
}
