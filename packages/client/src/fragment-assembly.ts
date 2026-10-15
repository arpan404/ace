import type { ServerMessage as Message } from "@ace/protocol";
import { FragmentPolicy } from "./fragment-policy.ts";
import type { Scheduler } from "./types.ts";

export type FragmentPart = Extract<Message, { type: "snapshot.part" | "entities.page.part" }>;

/** Whether reassembled fragments are the message their parts announced. */
export function matchesFragments(part: FragmentPart, complete: Message): boolean {
  if (part.type === "snapshot.part")
    return (
      complete.type === "snapshot" &&
      complete.subscriptionId === part.subscriptionId &&
      complete.seq === part.seq
    );
  return (
    complete.type === "entities.page" &&
    complete.requestId === part.requestId &&
    complete.page.threadId === part.threadId &&
    complete.page.seq === part.seq
  );
}

/**
 * The parts of fragmented server messages one socket is receiving, each source bounded in bytes
 * by the policy and in time by an absolute deadline from its first part.
 */
export class FragmentAssembly {
  #policy: FragmentPolicy;
  #scheduler: Scheduler;
  #deadlineMs: number;
  #timers = new Map<string, () => void>();
  constructor(budgetBytes: number, scheduler: Scheduler, deadlineMs: number) {
    this.#policy = new FragmentPolicy(budgetBytes);
    this.#scheduler = scheduler;
    this.#deadlineMs = deadlineMs;
  }
  /**
   * Add one part: the whole message's JSON once its last part arrives, otherwise undefined.
   * `timedOut` runs if a message started here isn't complete by its deadline. Throws a
   * `limit` ClientError over budget and a `protocol` one for a part out of sequence.
   */
  add(part: FragmentPart, timedOut: () => void): string | undefined {
    const key =
      part.type === "snapshot.part" ? `snapshot:${part.subscriptionId}` : `page:${part.requestId}`;
    const data = this.#policy.add(key, part.seq, part.index, part.data, part.done);
    if (part.index === 0) this.#timers.set(key, this.#scheduler.set(this.#deadlineMs, timedOut));
    if (data === undefined) return undefined;
    this.#timers.get(key)?.();
    this.#timers.delete(key);
    return data;
  }
  /** The socket ended: drop every partial message and its deadline. */
  clear(): void {
    this.#policy.clear();
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
  }
}
