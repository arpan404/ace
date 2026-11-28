import { expect, it, vi } from "vitest";
import { createLoadLifecycle } from "./load-lifecycle.ts";
import { createStartupTeardown } from "./startup-teardown.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("drains late loads before disconnecting, then flushes and closes in order", async () => {
  const order: string[] = [];
  const orphan = deferred<string>();
  const owner = createLoadLifecycle();
  owner.begin();
  owner.track(orphan.promise);

  const teardown = createStartupTeardown({
    owner,
    disconnectAll: async () => {
      order.push("disconnect");
    },
    flush: async () => {
      order.push("flush");
    },
    closeDb: async () => {
      order.push("close");
    },
  });

  const done = teardown.teardown();
  // Let the teardown reach the drain before releasing the orphan.
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual([]);
  orphan.resolve("studio");
  await done;
  expect(order).toEqual(["disconnect", "flush", "close"]);
});

it("a second teardown call shares the first instead of double-closing", async () => {
  const owner = createLoadLifecycle();
  const closeDb = vi.fn().mockResolvedValue(undefined);
  const disconnectAll = vi.fn().mockResolvedValue(undefined);
  const teardown = createStartupTeardown({
    owner,
    disconnectAll,
    flush: async () => {},
    closeDb,
  });
  await Promise.all([teardown.teardown(), teardown.teardown()]);
  expect(teardown.settled).toBe(true);
  expect(closeDb).toHaveBeenCalledTimes(1);
  expect(disconnectAll).toHaveBeenCalledTimes(1);
});

it("a failing disconnect still flushes and closes behind it", async () => {
  const order: string[] = [];
  const owner = createLoadLifecycle();
  const teardown = createStartupTeardown({
    owner,
    disconnectAll: async () => {
      order.push("disconnect");
      throw new Error("socket gone");
    },
    flush: async () => {
      order.push("flush");
    },
    closeDb: async () => {
      order.push("close");
    },
  });
  await teardown.teardown();
  expect(order).toEqual(["disconnect", "flush", "close"]);
});

it("per-generation teardowns disconnect their own manager, never a sibling", async () => {
  // Two startup generations, each with its own owner and manager. A retry
  // mints the second while the first load is still in flight; each teardown
  // must drain and disconnect only its own generation so the old manager
  // never leaks and the new one is never torn down early.
  const closed: string[] = [];
  const firstGate = deferred<string>();
  const secondGate = deferred<string>();

  const firstOwner = createLoadLifecycle();
  firstOwner.begin();
  const firstRaw = firstGate.promise;
  firstOwner.track(firstRaw);
  const first = createStartupTeardown({
    owner: firstOwner,
    disconnectAll: async () => {
      closed.push("first");
    },
    flush: async () => {},
    closeDb: async () => {
      closed.push("first-db");
    },
  });

  const secondOwner = createLoadLifecycle();
  secondOwner.begin();
  const secondRaw = secondGate.promise;
  secondOwner.track(secondRaw);
  const second = createStartupTeardown({
    owner: secondOwner,
    disconnectAll: async () => {
      closed.push("second");
    },
    flush: async () => {},
    closeDb: async () => {
      closed.push("second-db");
    },
  });

  const firstDone = first.teardown();
  const secondDone = second.teardown();
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toEqual([]);
  firstGate.resolve("a");
  secondGate.resolve("b");
  await Promise.all([firstDone, secondDone, firstRaw, secondRaw]);
  // Each generation disconnects its own manager before closing its own
  // database; the two generations run concurrently, so only per-generation
  // order is asserted (no sibling disconnects a sibling's handle).
  expect(closed).toContain("first");
  expect(closed).toContain("second");
  expect(closed.indexOf("first") < closed.indexOf("first-db")).toBe(true);
  expect(closed.indexOf("second") < closed.indexOf("second-db")).toBe(true);
});

it("phase one drains tracked table and prefs orphans before the final close", async () => {
  // Phase-one shape: the raw open resolves (adopted), then the table DDL
  // and the lock-prefs read hang. Teardown must wait for both orphans
  // before disconnecting/flushing/closing — never close under running work.
  const order: string[] = [];
  const ensureGate = deferred<string>();
  const prefsGate = deferred<{ prefs: Record<string, never>; storageFailed: boolean }>();
  const owner = createLoadLifecycle();
  owner.track(Promise.resolve("open"));
  owner.track(ensureGate.promise);
  owner.track(prefsGate.promise);
  const teardown = createStartupTeardown({
    owner,
    disconnectAll: async () => {
      order.push("disconnect");
    },
    flush: async () => {
      order.push("flush");
    },
    closeDb: async () => {
      order.push("close");
    },
  });
  const done = teardown.teardown();
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual([]);
  ensureGate.resolve("tables");
  await Promise.resolve();
  await Promise.resolve();
  // Prefs orphan still pending: the close must still wait.
  expect(order).toEqual([]);
  prefsGate.resolve({ prefs: {}, storageFailed: false });
  await done;
  expect(order).toEqual(["disconnect", "flush", "close"]);
});

it("a timed-out open closes the late handle once and the teardown close is a no-op", async () => {
  // Deferred real edge: the open hangs, the timeout wins, the orphan hook
  // closes the late handle, and the generation teardown (which never adopted
  // a handle) closes nothing — exactly one close total, never a double.
  const { withLoadTimeout, LoadTimeoutError } = await import("./load-timeout.ts");
  const openGate = deferred<{ closeAsync(): Promise<void> }>();
  const closes: string[] = [];
  const lateHandle = {
    closeAsync: async () => {
      closes.push("orphan");
    },
  };
  const owner = createLoadLifecycle();
  const openRaw = openGate.promise;
  owner.track(openRaw);
  let db: { closeAsync(): Promise<void> } | null = null;
  let dbClosed = false;
  const closeDbOnce = async (): Promise<void> => {
    if (dbClosed) return;
    dbClosed = true;
    const handle = db;
    db = null;
    await handle?.closeAsync().catch(() => undefined);
  };
  const pending = withLoadTimeout(openRaw, 10, (outcome) => {
    if (outcome.settled === "resolved") void outcome.value.closeAsync().catch(() => undefined);
  }).then(
    (handle) => {
      db = handle;
    },
    (error: unknown) => {
      if (!(error instanceof LoadTimeoutError)) throw error;
    },
  );
  const teardown = createStartupTeardown({
    owner,
    disconnectAll: async () => {},
    flush: async () => {},
    closeDb: async () => {
      await closeDbOnce();
    },
  });
  await expect(pending).resolves.toBeUndefined();
  expect(db).toBeNull();
  // Late open resolves after the timeout: the orphan hook closes it.
  openGate.resolve(lateHandle);
  await openRaw;
  await Promise.resolve();
  expect(closes).toEqual(["orphan"]);
  // The failure-path teardown drains the (now settled) orphan; it never
  // adopted a handle, so its close is a guarded no-op — the late handle was
  // still closed exactly once, never double-closed.
  await teardown.teardown();
  expect(closes).toEqual(["orphan"]);
});

it("a failed lock flush still closes, then reports instead of vanishing", async () => {
  const order: string[] = [];
  const owner = createLoadLifecycle();
  const teardown = createStartupTeardown({
    owner,
    disconnectAll: async () => {
      order.push("disconnect");
    },
    flush: async () => {
      order.push("flush");
      throw new Error("The app-lock choice could not be saved.");
    },
    closeDb: async () => {
      order.push("close");
    },
  });
  await expect(teardown.teardown()).rejects.toThrow("could not be saved");
  expect(order).toEqual(["disconnect", "flush", "close"]);
});

it("a hung phase-one orphan shows failure first while the background teardown still closes safely", async () => {
  // Deferred real edge for the production root failure path: a timed-out
  // table/prefs orphan hangs forever. `setFailure` must run before the
  // drain completes (recoverable Retry on screen), while the shared teardown
  // still drains first and closes last in the background — never closing
  // under the live orphan, never double-closing, and never adopting a
  // competing manager (the failed generation disconnects its own no-op
  // manager while the retry mints its own).
  const order: string[] = [];
  const hungGate = deferred<string>();
  hungGate.promise.then(undefined, () => undefined);
  const owner = createLoadLifecycle();
  owner.begin();
  owner.track(hungGate.promise);
  const teardown = createStartupTeardown({
    owner,
    disconnectAll: async () => {
      order.push("disconnect");
    },
    flush: async () => {
      order.push("flush");
    },
    closeDb: async () => {
      order.push("close");
    },
  });

  // Production-root failure order: surface Retry first, drain in background.
  let failure: string | null = null;
  let storageFailed = false;
  failure = "The connection could not start.";
  void teardown.teardown().catch(() => {
    storageFailed = true;
  });
  // Recoverable state is visible while the hung orphan still blocks the drain.
  await Promise.resolve();
  await Promise.resolve();
  expect(failure).toBe("The connection could not start.");
  expect(order).toEqual([]);
  expect(storageFailed).toBe(false);

  // The retry generation owns a fresh lifecycle/manager: it never shares the
  // failed generation's teardown and never disconnects a sibling.
  const retryOwner = createLoadLifecycle();
  retryOwner.begin();
  const retryTeardown = createStartupTeardown({
    owner: retryOwner,
    disconnectAll: async () => {
      order.push("retry-disconnect");
    },
    flush: async () => {},
    closeDb: async () => {
      order.push("retry-close");
    },
  });
  await retryTeardown.teardown();
  expect(order).toEqual(["retry-disconnect", "retry-close"]);

  // Late orphan settles: the failed generation now drains, disconnects its
  // own manager, and closes its own handle — exactly once.
  hungGate.resolve("tables");
  await teardown.teardown();
  expect(order).toEqual(["retry-disconnect", "retry-close", "disconnect", "flush", "close"]);
  expect(storageFailed).toBe(false);
});
