import { BrowserState } from "@ace/protocol";
import type { BrowserView } from "../sources.ts";

type Operation =
  | "browser.takeover"
  | "browser.handback"
  | "browser.subscribe"
  | "browser.unsubscribe";
interface Claim {
  mode: "shared" | "private";
  owner: string | undefined;
  pending: boolean;
  ambiguous: boolean;
  settled: Promise<void>;
}

/** Reconcile one-shot control requests whose reply can fail after the daemon applies them. */
export function previewControl(options: {
  call(type: Operation, threadId: string, mode?: "shared" | "private"): Promise<unknown>;
  view(threadId: string): BrowserView | undefined;
  watching(threadId: string): boolean;
}) {
  const claims = new Map<string, Claim>();
  const releases = new Map<string, { claim: Claim; work: Promise<void> }>();
  const forget = (threadId: string) => claims.delete(threadId);
  const forgetClaim = (threadId: string, claim: Claim) => {
    if (claims.get(threadId) === claim) forget(threadId);
  };
  const releaseClaim = (threadId: string, claim: Claim | undefined): Promise<void> => {
    if (!claim || claims.get(threadId) !== claim || claim.mode === "private")
      return Promise.resolve();
    const existing = releases.get(threadId);
    if (existing?.claim === claim) return existing.work;
    const work = (async () => {
      await claim.settled;
      if (claims.get(threadId) !== claim || claim.mode === "private") return;
      let reconciled = false;
      try {
        if (claim.ambiguous) {
          // The state push precedes this correlated result, even without a mounted watcher.
          reconciled = true;
          await options.call("browser.subscribe", threadId);
        }
        if (claims.get(threadId) !== claim) return;
        const current = options.view(threadId);
        if (current?.takeoverMode === "private") {
          forgetClaim(threadId, claim);
          return;
        }
        if (
          current &&
          (current.controller !== "human" ||
            (claim.owner !== undefined && current.owner !== claim.owner))
        ) {
          forgetClaim(threadId, claim);
          return;
        }
        try {
          // An ambiguous acquisition has no proven owner id. The daemon checks this
          // connection, so it cannot hand back another device's lease.
          await options.call("browser.handback", threadId);
        } catch (error) {
          const latest = options.view(threadId);
          if (
            latest?.controller === "agent" ||
            (error instanceof Error && error.message === "Browser controller mismatch")
          ) {
            forgetClaim(threadId, claim);
            return;
          }
          throw error;
        }
        forgetClaim(threadId, claim);
      } finally {
        if (reconciled && !options.watching(threadId))
          await options.call("browser.unsubscribe", threadId).catch(() => {});
      }
    })();
    releases.set(threadId, { claim, work });
    void work
      .finally(() => {
        if (releases.get(threadId)?.work === work) releases.delete(threadId);
      })
      .catch(() => {});
    return work;
  };
  const heldAs = (threadId: string) => {
    const claim = claims.get(threadId);
    const current = options.view(threadId);
    return claim?.owner !== undefined &&
      current?.controller === "human" &&
      current.owner === claim.owner
      ? claim.owner
      : undefined;
  };
  const takeover = async (threadId: string, mode: "shared" | "private" = "shared") => {
    const settled = Promise.withResolvers<void>();
    const previous = claims.get(threadId);
    const claim: Claim = {
      mode,
      owner: undefined,
      pending: true,
      ambiguous: false,
      settled: settled.promise,
    };
    claims.set(threadId, claim);
    try {
      const state = BrowserState.parse(await options.call("browser.takeover", threadId, mode));
      if (claims.get(threadId) === claim) {
        claim.owner = state.owner;
        claim.mode = state.takeoverMode ?? mode;
      }
    } catch (error) {
      claim.ambiguous = true;
      if (previous?.owner !== undefined && claims.get(threadId) === claim)
        claims.set(threadId, previous);
      throw error;
    } finally {
      claim.pending = false;
      settled.resolve();
    }
  };
  return {
    tracked: (threadId: string) => claims.has(threadId),
    forget,
    reset: () => claims.clear(),
    observe(state: BrowserState) {
      const claim = claims.get(state.threadId);
      if (!claim || claim.pending) return;
      if (
        state.controller !== "human" ||
        (claim.owner !== undefined && state.owner !== claim.owner)
      )
        forget(state.threadId);
    },
    takeover,
    heldAs,
    temporaryControl(threadId: string) {
      if (heldAs(threadId)) return { ready: Promise.resolve(), release: () => Promise.resolve() };
      const ready = takeover(threadId);
      const claim = claims.get(threadId);
      return { ready, release: () => releaseClaim(threadId, claim) };
    },
    async handback(threadId: string) {
      const claim = claims.get(threadId);
      await options.call("browser.handback", threadId);
      if (claims.get(threadId) === claim) forget(threadId);
    },
    releaseSharedControl: (threadId: string) => releaseClaim(threadId, claims.get(threadId)),
  };
}
