import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { CursorHost } from "./host.ts";
import { Limits, type CursorEnvelope, type CursorLimits } from "./contracts.ts";

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
    await wire.confirmed("frame", frame, ${ackMs});
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

// The package's own entries for each runtime: Bun loads its bundle, Node its ESM build.
const sdkDist = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..");
const sdkModule = (bun: boolean) =>
  pathToFileURL(join(sdkDist, bun ? "bundled/index.js" : "esm/index.js")).href;
const runtimeModule = new URL("./host-runtime.ts", import.meta.url).pathname;

/**
 * The real runtime behind the real wire, over a fake SDK whose run streams one message. Every
 * call into the SDK's send is written to stderr as "sdk-send".
 */
const runtimeHost = `const sdk = await import(process.versions.bun ? ${JSON.stringify(sdkModule(true))} : ${JSON.stringify(sdkModule(false))});
import { hostWire } from ${JSON.stringify(wire)};
import { HostRuntime } from ${JSON.stringify(runtimeModule)};
const run = {
  id: "run",
  async *stream() { yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }; },
  async wait() { return { id: "run", status: "finished" }; },
  async cancel() {},
};
const agent = {
  agentId: "agent",
  async [Symbol.asyncDispose]() {},
  async send() { process.stderr.write("sdk-send\\n"); return run; },
};
const boundary = {
  ...sdk,
  Cursor: { ...sdk.Cursor, auth: { ...sdk.Cursor.auth, async status() { return { status: "logged-in" }; } } },
  Agent: {
    async create() { return agent; },
    async resume() { throw new Error("no resume"); },
    async cancelRun() { throw new Error("no run"); },
  },
};
let runtime;
const wire = hostWire(async (method, params) => {
  if (method === "open") return runtime.open(params);
  if (method === "send") return runtime.send(params);
  throw new Error("unsupported");
}, () => process.exit(0));
runtime = new HostRuntime(boundary, (frame) => wire.confirmed("frame", frame, runtime.acknowledgementTimeoutMs));
`;

async function runtimeFixture(
  limits: Partial<CursorLimits>,
  store: (frame: CursorEnvelope) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-host-ack-runtime-")));
  const entry = join(root, "host.ts");
  await writeFile(entry, runtimeHost);
  const host = new CursorHost(
    { env: { HOME: root }, entry, generation: () => "gen", limits },
    (frame) => store(frame),
  );
  const sends: string[] = [];
  host.process.stderr.on("line", (line: string) => line === "sdk-send" && sends.push(line));
  const open = () =>
    host.request("open", {
      cwd: root,
      threadId: "ack-runtime",
      generation: "gen",
      policy: "full-access",
      limits: Limits.parse(limits),
    });
  const send = (operationId: string) =>
    host.request("send", { operationId, segment: 0, input: [{ type: "text", text: "go" }] });
  return {
    host,
    sends,
    open,
    send,
    async [Symbol.asyncDispose]() {
      await host.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const fenceOf = (frame: CursorEnvelope) =>
  frame.kind === "error" &&
  typeof frame.body === "object" &&
  frame.body !== null &&
  "code" in frame.body &&
  frame.body.code === "boundary_overflow"
    ? JSON.stringify(frame.body)
    : undefined;

it("a frame ace stores too late fences the turn, the late ack is harmless and no further send reaches Cursor", async () => {
  const fenced = Promise.withResolvers<string>();
  const lateStored = Promise.withResolvers<void>();
  await using fixture = await runtimeFixture({ ackTimeoutMs: 200 }, async (frame) => {
    const fence = fenceOf(frame);
    if (fence) fenced.resolve(fence);
    if (frame.kind === "message") {
      await sleep(600);
      lateStored.resolve();
    }
  });
  await fixture.open();
  await expect(fixture.send("first")).resolves.toEqual({ runId: "run" });
  expect(await fenced.promise).toMatch(/ace took too long to store a Cursor SDK frame/);
  await lateStored.promise;
  await sleep(100);
  expect(fixture.host.process.signal.aborted).toBe(false);
  await expect(fixture.send("second")).rejects.toThrow();
  expect(fixture.sends).toEqual(["sdk-send"]);
});

// ace stops waiting for open after timeoutMs; the host must not hold a stuck frame past that.
it("a frame stuck in storage while opening is fenced within the open request's deadline", async () => {
  const fenced = Promise.withResolvers<string>();
  const started = performance.now();
  await using fixture = await runtimeFixture(
    { timeoutMs: 300, ackTimeoutMs: 60_000 },
    async (frame) => {
      const fence = fenceOf(frame);
      if (fence) fenced.resolve(fence);
      if (frame.kind === "open") await sleep(3000);
    },
  );
  await expect(fixture.open()).rejects.toThrow();
  expect(await fenced.promise).toMatch(/ace took too long to store a Cursor SDK frame/);
  expect(performance.now() - started).toBeLessThan(2500);
});
