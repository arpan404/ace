import type { ClientCore } from "@ace/client";
import { listedSubagentState } from "@ace/ui-core/subagent-group";
import type { SpadeAgent } from "@ace/ui-core/spade-chat";
import type { SpadeBubbleRow } from "./spade-rows.ts";
import type { SpadeWorkerFacts } from "./spade-worker-rows.ts";

/*
 * The open Spade chat's ace workers as ace's thread list has them, live: while a conversation is
 * open this holds the SDK's list (shared with the inbox) and calls `changed` when a worker's
 * thread changes, or the list as a whole does, so the chat's rows follow without reopening it.
 */

const listWide = new Set(["ids", "unconfirmed", "sync", "error"]);

export class SpadeWorkerWatch {
  private lease: ReturnType<ClientCore["threads"]> | undefined;
  private stopObserving: (() => void) | undefined;
  /** The ace workers the open chat shows, by thread. */
  private shown: ReadonlySet<string> = new Set();
  private readonly owner: Pick<ClientCore, "threads">;
  private readonly changed: () => void;

  constructor(owner: Pick<ClientCore, "threads">, changed: () => void) {
    this.owner = owner;
    this.changed = changed;
  }

  /** What is known of the workers now, with bots from `agents`. */
  facts(
    agents: () => readonly SpadeAgent[] | undefined,
    node: SpadeWorkerFacts["node"],
  ): SpadeWorkerFacts {
    return {
      // The list is held only once a chat shows an ace worker.
      listed: (thread) => {
        const store = this.store();
        if (!store) return undefined;
        const state = listedSubagentState(store, thread);
        return state && { state, asking: store.thread(thread)?.live?.asking?.[0]?.kind };
      },
      bot: (id) => agents()?.find((agent) => agent.id === id),
      node,
    };
  }

  /** The open chat's rows as last put: only their ace workers' threads redraw it. */
  showing(rows: readonly { row: SpadeBubbleRow }[]): void {
    this.shown = new Set(
      rows.flatMap(({ row }) =>
        row.kind === "workers" ? row.workers.flatMap(({ thread }) => thread ?? []) : [],
      ),
    );
  }

  stop(): void {
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.lease?.release();
    this.lease = undefined;
    this.shown = new Set();
  }

  private store() {
    if (this.lease) return this.lease.store;
    try {
      this.lease = this.owner.threads();
    } catch {
      // Offline: the workers read as still at work until the list is back.
      return undefined;
    }
    this.stopObserving = this.lease.store.observe((keys) => {
      if (this.shown.size === 0) return;
      if (keys === "all") return this.changed();
      for (const key of keys)
        if (listWide.has(key) || (key.startsWith("thread:") && this.shown.has(key.slice(7))))
          return this.changed();
    });
    return this.lease.store;
  }
}
