import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { CursorHost } from "./host.ts";
import { runtimeFixture } from "./host-runtime-test-support.ts";

const wire = new URL("./host-wire.ts", import.meta.url).pathname;

/** A real hostWire child whose "send" stores one frame, waiting at most `ackMs` for the ack. */
async function hostStoringOneFrame(ackMs: number) {
  const root = await mkdtemp(join(tmpdir(), "cursor-host-ack-"));
  const entry = join(root, "host.ts");
  await writeFile(
    entry,
    `import { hostWire } from ${JSON.stringify(wire)};
const frame = { schemaVersion: 1, operationId: "op", generation: "gen", segment: 0, kind: "delta", body: {} };
const wire = hostWire(async (method) => {
  if (method !== "send") return { alive: true };
  try {
    const deadline = performance.now() + ${ackMs};
    await wire.confirmed("frame", frame, () => deadline - performance.now());
    return { stored: true };
  } catch (error) {
    return { stored: false, reason: error instanceof Error ? error.message : String(error) };
  }
}, () => process.exit(0));
`,
  );
  return { root, entry };
}

// A busy daemon (fsync, a long transaction) can answer a frame after the host stopped waiting.
it("a storage acknowledgement that arrives after the host stopped waiting leaves the host running", async () => {
  const { root, entry } = await hostStoringOneFrame(100);
  const stored = Promise.withResolvers<void>();
  const host = new CursorHost({ env: { HOME: root }, entry, generation: () => "gen" }, async () => {
    await sleep(400);
    stored.resolve();
  });
  try {
    await expect(host.request("send")).resolves.toEqual({
      stored: false,
      reason: expect.stringMatching(/acknowledgement expired/) as unknown,
    });
    await stored.promise;
    // The late reply is now on the host's stdin; the host must keep answering.
    await sleep(100);
    await expect(host.request("ping")).resolves.toEqual({ alive: true });
    expect(host.process.signal.aborted).toBe(false);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("a frame ace stores too late fences the turn, the late ack is harmless and no further send reaches Cursor", async () => {
  const lateStored = Promise.withResolvers<void>();
  await using fixture = await runtimeFixture({ ackTimeoutMs: 200 }, async (frame) => {
    if (frame.kind === "message") {
      await sleep(600);
      lateStored.resolve();
    }
  });
  await fixture.open();
  await expect(fixture.send("first")).resolves.toEqual({ runId: "run" });
  expect(await fixture.fenced).toMatch(/ace took too long to store a Cursor SDK frame/);
  await lateStored.promise;
  await sleep(100);
  expect(fixture.host.process.signal.aborted).toBe(false);
  await expect(fixture.send("second")).rejects.toThrow();
  expect(fixture.sdkCalls().filter((call) => call === "sdk-send")).toEqual(["sdk-send"]);
});

// ace stops waiting for open after timeoutMs; the host must not hold a stuck frame past that.
it("a frame stuck in storage while opening is fenced within the open request's deadline", async () => {
  await using fixture = await runtimeFixture({ timeoutMs: 300, ackTimeoutMs: 60_000 }, (frame) =>
    frame.kind === "open" ? sleep(3000) : Promise.resolve(),
  );
  await fixture.ping();
  const started = performance.now();
  await expect(fixture.open()).rejects.toThrow();
  expect(await fixture.fenced).toMatch(/ace took too long to store a Cursor SDK frame/);
  expect(performance.now() - started).toBeLessThan(2500);
});

// The open deadline counts from the request, not from the frame: setup time is already spent.
it("a frame stuck after slow setup is fenced by the open request's deadline, not a fresh one", async () => {
  await using fixture = await runtimeFixture(
    { timeoutMs: 1000, ackTimeoutMs: 60_000 },
    (frame) => (frame.kind === "open" ? sleep(5000) : Promise.resolve()),
    { statusDelayMs: 600 },
  );
  await fixture.ping();
  const started = performance.now();
  await expect(fixture.open()).rejects.toThrow();
  await fixture.fenced;
  expect(performance.now() - started).toBeLessThan(1400);
});

// A frame a running turn emitted keeps its long budget only until a shorter request needs it.
it("a frame already waiting on storage is fenced within the deadline of a cancel that waits on it", async () => {
  await using fixture = await runtimeFixture({ timeoutMs: 1000, ackTimeoutMs: 60_000 }, (frame) =>
    frame.kind === "message" ? sleep(10_000) : Promise.resolve(),
  );
  await fixture.open();
  await fixture.send("first");
  await sleep(200);
  const started = performance.now();
  await expect(fixture.cancel()).rejects.toThrow();
  expect(await fixture.fenced).toMatch(/ace took too long to store a Cursor SDK frame/);
  expect(performance.now() - started).toBeLessThan(2500);
});
