import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { cursorStoreUnusable } from "./store-fence.ts";
import { checkpointDirectory } from "./checkpoints.ts";
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
    frame.kind === "delta"
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
    (frame) => (frame.kind === "delta" ? storageFailed() : Promise.resolve()),
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
      (frame) => (frame.kind === "delta" ? storageFailed() : Promise.resolve()),
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

it("a store that outgrew its budget during a turn says, at the turn's end, that the thread needs a fresh session", async () => {
  await using fixture = await runtimeFixture(
    { maxCheckpointBytes: 200_000 },
    () => Promise.resolve(),
    { checkpointBlobBytes: 400_000, runError: "done" },
  );
  await fixture.open();
  await fixture.send("first");
  const fence = await fixture.fenced;
  expect(fence).toContain("SDK checkpoint exceeds its budget");
  // The words the engine reads as an unusable store: the next open hands off (ADR 0211).
  expect(cursorStoreUnusable(fence)).toBe(true);
});

it("an old ace-boundary.ndjson left on disk, even a torn one, does not block the thread", async () => {
  const stored: string[] = [];
  await using fixture = await runtimeFixture({}, async (frame) => {
    stored.push(frame.kind);
  });
  const folder = checkpointDirectory(fixture.root, "host-runtime");
  await mkdir(folder, { recursive: true });
  const torn = '{"schemaVersion":1,"boundaryOffset":2,"kind":"delta"}\n{"schemaVersion":1,"bound';
  await writeFile(join(folder, "ace-boundary.ndjson"), torn);
  await fixture.open();
  await expect(fixture.send("first")).resolves.toEqual({ runId: "run" });
  expect(stored).toContain("segment");
  expect(fixture.events).not.toContain("fence");
  // Left as it was, for a downgrade or a diagnosis.
  expect(await readFile(join(folder, "ace-boundary.ndjson"), "utf8")).toBe(torn);
});
