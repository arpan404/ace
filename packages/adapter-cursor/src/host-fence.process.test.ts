import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { runtimeFixture } from "./host-runtime-test-support.ts";

const storageFailed = () => Promise.reject(new Error("database is locked"));
/** "cancelled" once the SDK run is cancelled, or "still running" after `ms`. */
const cancelledWithin = (reached: Promise<void>, ms: number) =>
  Promise.race([reached.then(() => "cancelled"), sleep(ms).then(() => "still running")]);

// The run was admitted, but ace could not record that it exists, nor the fence notice.
it("a run admitted before its segment frame could be stored is cancelled even when the fence notice cannot be stored", async () => {
  await using fixture = await runtimeFixture({}, (frame) =>
    frame.kind === "segment" || frame.kind === "error" ? storageFailed() : Promise.resolve(),
  );
  await fixture.open();
  await expect(fixture.send("first")).rejects.toThrow();
  expect(await cancelledWithin(fixture.reached("sdk-cancel"), 2000)).toBe("cancelled");
});

it("a turn fenced while streaming is cancelled without waiting for its fence notice to be stored", async () => {
  await using fixture = await runtimeFixture({ ackTimeoutMs: 4000 }, (frame) =>
    frame.kind === "message"
      ? storageFailed()
      : frame.kind === "error"
        ? sleep(6000)
        : Promise.resolve(),
  );
  await fixture.open();
  await expect(fixture.send("first")).resolves.toEqual({ runId: "run" });
  expect(await cancelledWithin(fixture.reached("sdk-cancel"), 1500)).toBe("cancelled");
});

// ace treats the fence notice as the turn's end, so it must not arrive while the run still works.
it("a fenced turn's notice is published only after its SDK run has stopped", async () => {
  await using fixture = await runtimeFixture(
    {},
    (frame) => (frame.kind === "message" ? storageFailed() : Promise.resolve()),
    { cancelDelayMs: 300 },
  );
  await fixture.open();
  await fixture.send("first");
  await fixture.fenced;
  expect(fixture.events.indexOf("sdk-cancelled")).toBeGreaterThan(-1);
  expect(fixture.events.indexOf("fence")).toBeGreaterThan(fixture.events.indexOf("sdk-cancelled"));
});

for (const cancel of ["hang", "reject"] as const) {
  it(`a fenced run whose cancel ${cancel === "hang" ? "hangs" : "fails"} ends its host with the original cause instead of reporting it stopped`, async () => {
    await using fixture = await runtimeFixture(
      { timeoutMs: 2000 },
      (frame) => (frame.kind === "message" ? storageFailed() : Promise.resolve()),
      { cancel },
    );
    await fixture.ping();
    await fixture.open();
    await fixture.send("first");
    const ended = await Promise.race([
      fixture.host.process.exited.then(() => "host ended"),
      sleep(6000).then(() => "host still running"),
    ]);
    expect(ended).toBe("host ended");
    expect(fixture.events).not.toContain("fence");
    expect(fixture.host.stopCause).toContain("database is locked");
  }, 15_000);
}

it("a checkpoint write ace refuses fences the turn, cancels its run first and names the cause", async () => {
  await using fixture = await runtimeFixture(
    { maxCheckpointBytes: 1_000_000 },
    () => Promise.resolve(),
    {
      checkpointBlobBytes: 800_000,
    },
  );
  await fixture.open();
  await fixture.send("first");
  expect(await fixture.fenced).toContain("blob exceeds budget");
  expect(fixture.events.indexOf("sdk-cancelled")).toBeGreaterThan(-1);
  expect(fixture.events.indexOf("fence")).toBeGreaterThan(fixture.events.indexOf("sdk-cancelled"));
});
