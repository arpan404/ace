import { spawn } from "node:child_process";
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
    await wire.confirmed("frame", frame, AbortSignal.timeout(${ackMs}));
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

// A daemon that stops reading fills the host's stdout pipe. The expiry must still reach the
// runtime, which can only fence and cancel the turn once its storage wait ends.
it("a frame stuck behind a full pipe still expires, so the host can fence the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-host-ack-pipe-"));
  const entry = join(root, "host.ts");
  await writeFile(
    entry,
    `import { hostWire } from ${JSON.stringify(wire)};
const frame = { schemaVersion: 1, operationId: "op", generation: "gen", segment: 0, kind: "delta", body: { text: "x".repeat(900_000) } };
const wire = hostWire(async () => {
  try {
    await wire.confirmed("frame", frame, AbortSignal.timeout(300));
  } catch (error) {
    process.stderr.write("storage wait ended: " + (error instanceof Error ? error.message : String(error)) + "\\n");
  }
  return {};
}, () => process.exit(0));
`,
  );
  // This parent never reads the child's stdout, as a stalled daemon would not.
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.pause();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send" })}\n`);
    for (let waited = 0; waited < 3000 && !stderr.includes("storage wait ended"); waited += 50)
      await sleep(50);
    expect(stderr).toContain("storage wait ended: ace took too long to store a Cursor SDK frame");
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

// A cancel that starts while a frame waits must cut that wait at its own deadline, not later.
it("a short cancel deadline cuts the wait of a frame already waiting at once", async () => {
  await using fixture = await runtimeFixture({ timeoutMs: 300, ackTimeoutMs: 60_000 }, (frame) =>
    frame.kind === "message" ? sleep(10_000) : Promise.resolve(),
  );
  await fixture.ping();
  await fixture.open(undefined, 15_000);
  await fixture.host.request(
    "send",
    { operationId: "first", segment: 0, input: [{ type: "text", text: "go" }] },
    15_000,
  );
  await sleep(50);
  const started = performance.now();
  void fixture.cancel().catch(() => {});
  await fixture.fenced;
  expect(performance.now() - started).toBeLessThan(700);
});
