import type { ClientCore } from "@ace/client";
import {
  WorkspaceActionRequest,
  type ForgeBrowserOperation,
  type ForgeBrowserResult,
  type ForgeGroupCounting,
  type ForgeIssueList,
  type ForgeIssueSearch,
  type ForgePrList,
  type ForgePrSearch,
} from "@ace/protocol";
import { linkedWork, type LinkedThreads } from "@ace/ui-core";

/*
 * The forge reads behind the phone's Pull requests and Issues, through the daemon's
 * `workspace.request` (the person's own `gh`, ADR 0002). A list page is kept half a minute, as
 * the web keeps it, so switching filters back or reopening a list doesn't ask GitHub again;
 * pulling to refresh reads afresh, and so does anything that puts the kept forge reads out of
 * date (a forge event, a merge, the connection coming back). Linked threads come from the threads this runtime holds.
 */

export type ForgeOwner = Pick<ClientCore, "request" | "command" | "threads">;

/** A forge read the daemon refused, with its code for the shared refusal wording. */
export class ForgeRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ForgeRefusal";
    this.code = code;
  }
}

type Operation = ForgeBrowserOperation extends infer Each
  ? Each extends { workspaceId: unknown }
    ? Omit<Each, "workspaceId"> & { workspaceId: string }
    : never
  : never;

/** How long a list page is answered from memory. */
export const listFreshMs = 30_000;
const keepAtMost = 200;

/** A remembered forge answer and the kept-reads stamp it was asked under (`NativeReads.stamp`). */
export interface ForgeMemory {
  at: number;
  stamp: string;
  value: ForgeBrowserResult;
}

export class ForgeReads {
  #owner: ForgeOwner;
  #now: () => number;
  #signal: AbortSignal;
  #fresh: boolean;
  #cache: Map<string, ForgeMemory>;
  #stamp: string;

  constructor(
    owner: ForgeOwner,
    now: () => number,
    cache: Map<string, ForgeMemory>,
    signal: AbortSignal,
    /** Pull to refresh: read GitHub again rather than answer from memory. */
    fresh: boolean,
    /**
     * The forge reads' stamp when this request was asked: a forge event, write or reconnect
     * changes it, and memory from another stamp is never given again.
     */
    stamp = "",
  ) {
    this.#owner = owner;
    this.#now = now;
    this.#cache = cache;
    this.#signal = signal;
    this.#fresh = fresh;
    this.#stamp = stamp;
  }

  /** One read, answered from memory while fresh when `cached`. */
  async read(operation: Operation, cached: boolean): Promise<ForgeBrowserResult> {
    const key = JSON.stringify(operation);
    const hit = this.#cache.get(key);
    if (
      cached &&
      !this.#fresh &&
      hit &&
      hit.stamp === this.#stamp &&
      this.#now() - hit.at < listFreshMs
    )
      return hit.value;
    const reply = await this.#owner.request(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "forge-read",
        operation,
      }),
      { signal: this.#signal, timeoutMs: 30_000 },
    );
    if (reply.result.kind === "error") throw new ForgeRefusal(reply.result.code);
    if (reply.result.kind !== "forge") throw new ForgeRefusal("forge_invalid_data");
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, { at: this.#now(), stamp: this.#stamp, value: reply.result.data });
      // The oldest entries go first once the memory holds enough lists.
      for (const old of this.#cache.keys()) {
        if (this.#cache.size <= keepAtMost) break;
        this.#cache.delete(old);
      }
    }
    return reply.result.data;
  }

  async prPage(project: string, query: ForgePrSearch, page: number): Promise<ForgePrList> {
    const value = await this.read(
      { op: "forge.pr.list", workspaceId: project, query: { ...query, page } },
      true,
    );
    if (value.resource !== "prList") throw new ForgeRefusal("forge_invalid_data");
    return value.value;
  }

  async issuePage(project: string, query: ForgeIssueSearch, page: number): Promise<ForgeIssueList> {
    const value = await this.read(
      { op: "forge.issue.list", workspaceId: project, query: { ...query, page } },
      true,
    );
    if (value.resource !== "issueList") throw new ForgeRefusal("forge_invalid_data");
    return value.value;
  }

  async groupCounts(
    project: string,
    grouping: ForgeGroupCounting,
  ): Promise<Record<string, number>> {
    const value = await this.read(
      { op: "forge.group-counts", workspaceId: project, grouping },
      true,
    );
    if (value.resource !== "groupCounts") throw new ForgeRefusal("forge_invalid_data");
    return value.counts;
  }

  /** Which PRs and issues this runtime's threads are linked to, as the web's rows name them. */
  linked(): { pulls: LinkedThreads; issues: LinkedThreads } {
    const lease = this.#owner.threads();
    try {
      return linkedWork(lease.store);
    } finally {
      lease.release();
    }
  }

  /** Forget every remembered list of a project: a merge or write changed what they show. */
  forget(project: string): void {
    for (const key of this.#cache.keys())
      if (key.includes(`"workspaceId":${JSON.stringify(project)}`)) this.#cache.delete(key);
  }
}
