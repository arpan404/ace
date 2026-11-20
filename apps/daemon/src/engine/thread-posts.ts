import type { ItemDraft } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/**
 * Messages ace posts in a thread for the person, outside any provider turn (ADR 0194): a message
 * they addressed to bots, clubs or agents, and each bot's reply. They sit on the root agent's
 * transcript, so they order with everything else, but no provider ever receives them.
 */
export class ThreadPosts {
  private repo: EngineRepository;
  private now: () => number;
  constructor(repo: EngineRepository, now: () => number) {
    this.repo = repo;
    this.now = now;
  }
  /** Writes the item under `key`, or replaces what that key holds. */
  post(threadId: ThreadId, key: string, draft: ItemDraft): void {
    const agent = this.repo.requireState(threadId).rootKey ?? "root";
    this.repo.apply(threadId, [{ type: "item.upsert", agent, item: key, draft }], this.now());
  }
}
