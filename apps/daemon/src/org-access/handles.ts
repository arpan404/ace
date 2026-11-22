import type { Decision, Operation, Resource } from "./decide.ts";

/*
 * Live handles and queued effects under the access policy (ADR 0209 §4.2). A handle (a
 * subscription, a terminal, a file stream, a browser session, an MCP lease, a provider op) is
 * bound to the operation and resource it was allowed for when it was made, and `revalidate`
 * closes every one its holder may no longer have. A queued effect records the decision's inputs
 * and is decided again the moment it runs. No I/O: closing is the caller's callback.
 */

export type Decider = (operation: Operation, resource: Resource) => Decision;

export type BoundHandle = {
  operation: Operation;
  /** Fixed when the handle was made, never re-derived from a later request. */
  resource: Resource;
  close(reason: string): void;
};

export class Handles {
  readonly #live = new Set<BoundHandle>();

  /** Keeps `handle` until it is released or loses its access. Returns the release. */
  bind(handle: BoundHandle): () => void {
    this.#live.add(handle);
    return () => {
      this.#live.delete(handle);
    };
  }

  get size(): number {
    return this.#live.size;
  }

  /** Closes, and forgets, every handle `decide` no longer allows. Returns how many closed. */
  revalidate(decide: Decider): number {
    let closed = 0;
    // Deleting the entry being visited is safe while iterating a Set.
    for (const handle of this.#live) {
      const decision = decide(handle.operation, handle.resource);
      if (decision.allowed) continue;
      this.#live.delete(handle);
      closed += 1;
      handle.close(decision.reason);
    }
    return closed;
  }

  /** Forgets every handle without closing it: their holder closed them itself. */
  clear(): void {
    this.#live.clear();
  }
}

/**
 * Runs a queued effect only if `decide` still allows it now, against the principal that
 * queued it (`decide` is bound to that principal by the caller). One that fails is dropped,
 * and `dropped` is told why so its owner can be told.
 */
export async function runIfStillAllowed<T>(
  effect: { operation: Operation; resource: Resource; run(): Promise<T> | T },
  decide: Decider,
  dropped: (reason: string) => void,
): Promise<T | undefined> {
  const decision = decide(effect.operation, effect.resource);
  if (!decision.allowed) {
    dropped(decision.reason);
    return undefined;
  }
  return effect.run();
}
