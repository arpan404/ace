import { describe, expect, it } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { ThreadLiveness, type LivenessPorts } from "./thread-liveness.ts";

const id = "t" as ThreadId;

/** A thread whose provider is being closed by someone else: the session is gone, not the process. */
function inFlight() {
  const exit = Promise.withResolvers<void>();
  let closing = true;
  const actor = { session: undefined, lifetime: undefined, flush: async () => {} };
  const sessions = {
    opening: () => undefined,
    closed: () => (closing ? exit.promise : undefined),
    isClosing: () => closing,
    close: async () => {},
  };
  const liveness = new ThreadLiveness({
    actor: () => actor,
    sessions,
  } as unknown as LivenessPorts);
  return {
    liveness,
    exited: () => {
      closing = false;
      exit.resolve();
    },
  };
}

describe("closing a moving thread's provider (ADR 0191)", () => {
  it("waits for a close already in flight until its process has exited", async () => {
    const t = inFlight();
    let done = false;
    const closing = t.liveness.closeProvider(id).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    t.exited();
    await closing;
    expect(done).toBe(true);
  });

  it("refuses to report done while the provider still runs", async () => {
    const actor = { session: {}, lifetime: undefined, flush: async () => {} };
    const sessions = {
      opening: () => undefined,
      closed: () => undefined,
      isClosing: () => false,
      // Every close fails: the old process still owns the session.
      close: async () => {
        throw new Error("no exit acknowledgement");
      },
    };
    const liveness = new ThreadLiveness({
      actor: () => actor,
      sessions,
    } as unknown as LivenessPorts);
    await expect(liveness.closeProvider(id)).rejects.toThrow("didn't exit");
  });
});

describe("a provider still opening when the move closes it (ADR 0191)", () => {
  it("is ended and waited for, and counts as the thread's process until it has gone", async () => {
    const handshake = Promise.withResolvers<void>();
    let opening: Promise<void> | undefined = handshake.promise;
    const lifetime = new AbortController();
    // Aborting the open's lifetime ends the spawned process; the open then settles.
    lifetime.signal.addEventListener("abort", () => {
      setTimeout(() => {
        opening = undefined;
        handshake.resolve();
      }, 20);
    });
    const actor = { session: undefined, lifetime, flush: async () => {} };
    const sessions = {
      opening: () => opening,
      closed: () => undefined,
      isClosing: () => false,
      close: async () => {},
    };
    const liveness = new ThreadLiveness({
      actor: () => actor,
      sessions,
    } as unknown as LivenessPorts);
    expect(liveness.hasProcess(id)).toBe(true);
    let done = false;
    const closing = liveness.closeProvider(id).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lifetime.signal.aborted).toBe(true);
    expect(done).toBe(false);
    await closing;
    expect(liveness.hasProcess(id)).toBe(false);
  });
});
