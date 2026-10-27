import { expect, it, vi } from "vitest";
import { createCoalescingFlight, createSingleFlight } from "./single-flight.ts";

it("refuses a second same-tick acquisition while held", () => {
  const gate = createSingleFlight();
  expect(gate.tryAcquire()).toBe(true);
  // No await between the two: this is the double-tap same-tick case where
  // React state would still read `false` for both presses.
  expect(gate.tryAcquire()).toBe(false);
  expect(gate.held).toBe(true);
});

it("allows the next attempt after the first settles", () => {
  const gate = createSingleFlight();
  expect(gate.tryAcquire()).toBe(true);
  gate.release();
  expect(gate.held).toBe(false);
  expect(gate.tryAcquire()).toBe(true);
});

it("release without acquire stays released", () => {
  const gate = createSingleFlight();
  gate.release();
  expect(gate.tryAcquire()).toBe(true);
});

it("a same-tick second pair shares the in-flight redeem instead of throwing", async () => {
  // Actual wiring behavior: the duplicate press must be silently ignored (one
  // redeem, no error), not rejected with "already in progress".
  let calls = 0;
  let release!: (value: string) => void;
  const work = vi.fn(async () => {
    calls += 1;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });
  const pair = createCoalescingFlight(work);

  const first = pair();
  // No await between the two: the double-tap same-tick case.
  const second = pair();
  expect(second).toBe(first);
  expect(work).toHaveBeenCalledTimes(1);

  release("host-1");
  await expect(first).resolves.toBe("host-1");
  await expect(second).resolves.toBe("host-1");
  expect(calls).toBe(1);
});

it("a settled flight allows the next redeem", async () => {
  let calls = 0;
  const pair = createCoalescingFlight(async (code: string) => {
    calls += 1;
    return `paired:${code}`;
  });
  await expect(pair("first")).resolves.toBe("paired:first");
  await expect(pair("second")).resolves.toBe("paired:second");
  expect(calls).toBe(2);
});

it("a failed redeem settles both same-tick callers with one invocation", async () => {
  const failure = new Error("daemon refused reuse");
  const work = vi.fn(async () => {
    throw failure;
  });
  const pair = createCoalescingFlight(work);
  const first = pair();
  const second = pair();
  expect(second).toBe(first);
  await expect(first).rejects.toBe(failure);
  await expect(second).rejects.toBe(failure);
  expect(work).toHaveBeenCalledTimes(1);
});

it("a distinct pairing request never shares the in-flight host", async () => {
  const releases: Array<(value: string) => void> = [];
  const work = vi.fn(
    async (_code: string): Promise<string> =>
      new Promise<string>((resolve) => {
        releases.push(resolve);
      }),
  );
  const pair = createCoalescingFlight(work, { key: (code: string) => code });
  const first = pair("code-a");
  // Same tick, different link code: must reject, not resolve to host-A.
  await expect(pair("code-b")).rejects.toThrow("already in progress");
  expect(work).toHaveBeenCalledTimes(1);
  releases[0]?.("host-a");
  await expect(first).resolves.toBe("host-a");
  // After settle the next code redeems normally.
  const third = pair("code-b");
  releases[1]?.("host-b");
  await expect(third).resolves.toBe("host-b");
  expect(work).toHaveBeenCalledTimes(2);
});

it("the same pairing code shares while a different signal aborts alone", async () => {
  let release!: (value: string) => void;
  let calls = 0;
  async function work(_code: string, _signal?: AbortSignal): Promise<string> {
    calls += 1;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  }
  const pair = createCoalescingFlight<[string, (AbortSignal | undefined)?], string>(work, {
    key: (code: string) => code,
  });
  const first = pair("code-a");
  const secondCtrl = new AbortController();
  const second = pair("code-a", secondCtrl.signal);
  secondCtrl.abort();
  await expect(second).rejects.toMatchObject({ code: "aborted" });
  // The shared redeem still runs for the first caller.
  release("host-a");
  await expect(first).resolves.toBe("host-a");
  expect(calls).toBe(1);
});

it("rejects a distinct request with the caller-typed busy error", async () => {
  class BusyError extends Error {
    readonly failure = "daemon" as const;
  }
  let release!: (value: string) => void;
  const pair = createCoalescingFlight<[string], string>(
    async () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    { key: (code: string) => code, busyError: () => new BusyError("Pairing already in progress.") },
  );
  const first = pair("code-a");
  await expect(pair("code-b")).rejects.toBeInstanceOf(BusyError);
  release("host-a");
  await expect(first).resolves.toBe("host-a");
});

it("a timed-out flight frees the next attempt while the orphan still runs", async () => {
  // No native cancellation: the timeout (inside the work, not around the
  // flight) rejects the waiter and clears the flight, but the orphaned
  // redeem still runs on. A retry may then hit the duplicate-pairing path.
  const { withLoadTimeout } = await import("./load-timeout.ts");
  let orphanRelease!: (value: string) => void;
  const orphan = new Promise<string>((resolve) => {
    orphanRelease = resolve;
  });
  let calls = 0;
  const pair = createCoalescingFlight(async () => {
    calls += 1;
    if (calls === 1) return withLoadTimeout(orphan, 10);
    return "fresh";
  });
  await expect(pair()).rejects.toMatchObject({ name: "LoadTimeoutError" });
  expect(calls).toBe(1);
  // Flight cleared by the timeout: the next attempt starts fresh work.
  await expect(pair()).resolves.toBe("fresh");
  // The orphan still runs on — nothing was cancelled.
  orphanRelease("late");
  await expect(orphan).resolves.toBe("late");
});
