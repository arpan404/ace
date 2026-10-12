import { expect, test } from "vitest";
import { stalledFetch, transferHarness } from "./repository-transfer-test-support.ts";

const refused = { ok: false, error: "workspace_change_in_progress" };
const contained = {
  status: "confirmed",
  evidence: "Exclusive fixture transport group contained",
} as const;

test.each(["rejected", "unconfirmed"])(
  "%s cleanup keeps daemon sends and new transfers refused",
  async (outcome) => {
    const h = await transferHarness();
    let fetch: Awaited<ReturnType<typeof stalledFetch>> | undefined;
    try {
      const current = await stalledFetch(h);
      fetch = current;
      const error = await current.fail("cancellation");
      if (outcome === "rejected")
        current.containment.reject(new Error("Supervisor lost containment proof"));
      else current.containment.resolve({ status: "unconfirmed", reason: "No containment proof" });
      if (!error.cleanup) throw new Error("Missing transfer cleanup receipt");
      expect(await error.cleanup.settled).toMatchObject({ status: "unconfirmed" });
      expect(() => current.checkAlive()).not.toThrow();
      expect(h.followUp()).toMatchObject(refused);
      await h.engine.flush();
      expect(h.state()).toBe("done");
      await expect(current.retry()).rejects.toThrow("repository_transfer_in_progress");
      // Refusing the new transfer must not release the failed transfer's ownership.
      expect(h.followUp()).toMatchObject(refused);
      await current.stop();
      expect(h.followUp()).toMatchObject(refused);
    } finally {
      await fetch?.close();
      await h.close();
    }
  },
);

test("a pending cleanup fence survives closing and reopening the daemon's SQLite store", async () => {
  const h = await transferHarness();
  let fetch: Awaited<ReturnType<typeof stalledFetch>> | undefined;
  try {
    const current = await stalledFetch(h);
    fetch = current;
    const error = await current.fail("cancellation");
    expect(h.followUp()).toMatchObject(refused);
    await h.restart();
    expect(() => current.checkAlive()).not.toThrow();
    expect(h.followUp()).toMatchObject(refused);
    await expect(current.retry()).rejects.toThrow("repository_transfer_in_progress");
    await current.stop();
    current.containment.resolve({
      status: "unconfirmed",
      reason: "Supervisor did not survive restart",
    });
    if (!error.cleanup) throw new Error("Missing transfer cleanup receipt");
    await error.cleanup.settled;
    expect(h.followUp()).toMatchObject(refused);
    await expect(current.retry()).rejects.toThrow("repository_transfer_in_progress");
  } finally {
    await fetch?.close();
    await h.close();
  }
});

test("a subsequent transfer owns admission independently of an earlier confirmed cleanup", async () => {
  const h = await transferHarness();
  let first: Awaited<ReturnType<typeof stalledFetch>> | undefined;
  let second: Awaited<ReturnType<typeof stalledFetch>> | undefined;
  try {
    const previous = await stalledFetch(h);
    first = previous;
    const firstError = await previous.fail("cancellation");
    await expect(previous.retry()).rejects.toThrow("repository_transfer_in_progress");
    expect(h.followUp()).toMatchObject(refused);
    await previous.stop();
    previous.containment.resolve(contained);
    if (!firstError.cleanup) throw new Error("Missing first transfer cleanup receipt");
    await firstError.cleanup.settled;
    await h.engine.flush();
    const current = await stalledFetch(h);
    second = current;
    // Closing the earlier service and refusing another request cannot unlock this live transfer.
    await previous.close();
    expect(() => current.checkAlive()).not.toThrow();
    expect(h.followUp()).toMatchObject(refused);
    await expect(current.retry()).rejects.toThrow("repository_transfer_in_progress");
    expect(h.followUp()).toMatchObject(refused);
    const secondError = await current.fail("cancellation");
    await previous.close();
    expect(h.followUp()).toMatchObject(refused);
    await current.stop();
    expect(h.followUp()).toMatchObject(refused);
    current.containment.resolve(contained);
    if (!secondError.cleanup) throw new Error("Missing subsequent transfer cleanup receipt");
    await secondError.cleanup.settled;
    expect(h.followUp()).toMatchObject({ ok: true });
    await h.engine.flush();
    expect(h.state()).toBe("working");
  } finally {
    await second?.close();
    await first?.close();
    await h.close();
  }
});
