import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CursorHost } from "./host.ts";
import { Limits, type CursorEnvelope, type CursorLimits } from "./contracts.ts";

// The package's own entries for each runtime: Bun loads its bundle, Node its ESM build.
const sdkDist = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..");
const sdkModule = (bun: boolean) =>
  pathToFileURL(join(sdkDist, bun ? "bundled/index.js" : "esm/index.js")).href;
const wireModule = new URL("./host-wire.ts", import.meta.url).pathname;
const runtimeModule = new URL("./host-runtime.ts", import.meta.url).pathname;

/** What the fake SDK inside the child does. */
export interface FakeSdkScenario {
  /** Milliseconds the SDK's auth status takes, as a slow network would. */
  statusDelayMs?: number;
  /** The run's streamed message; it then stays running until cancelled. */
  message?: unknown;
  /** The run finishes with this error right after its message instead of waiting. */
  runError?: string;
}

/**
 * The real runtime behind the real wire, wired as the host entry wires them, over a fake SDK.
 * The fake writes "sdk-send" and "sdk-cancel" to stderr when ace reaches it.
 */
const runtimeHost = (scenario: FakeSdkScenario) => `
const sdk = await import(process.versions.bun ? ${JSON.stringify(sdkModule(true))} : ${JSON.stringify(sdkModule(false))});
const { hostWire } = await import(${JSON.stringify(wireModule)});
const { HostRuntime } = await import(${JSON.stringify(runtimeModule)});
const scenario = ${JSON.stringify(scenario)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cancelled = Promise.withResolvers();
const run = {
  id: "run",
  async *stream() {
    yield scenario.message ?? { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
    if (scenario.runError === undefined) await cancelled.promise;
  },
  async wait() {
    return scenario.runError === undefined
      ? { id: "run", status: "cancelled" }
      : { id: "run", status: "error", error: { message: scenario.runError } };
  },
  async cancel() { process.stderr.write("sdk-cancel\\n"); cancelled.resolve(); },
};
const agent = {
  agentId: "agent",
  async [Symbol.asyncDispose]() {},
  async send() { process.stderr.write("sdk-send\\n"); return run; },
};
const boundary = {
  ...sdk,
  Cursor: { ...sdk.Cursor, auth: { ...sdk.Cursor.auth, async status() {
    await sleep(scenario.statusDelayMs ?? 0);
    return { status: "logged-in" };
  } } },
  Agent: {
    async create() { return agent; },
    async resume() { throw new Error("no resume"); },
    async cancelRun() { throw new Error("no run"); },
  },
};
let runtime;
const wire = hostWire(async (method, params) => {
  if (method === "ping") return { alive: true };
  if (method === "open") return runtime.open(params);
  if (method === "send") return runtime.send(params);
  if (method === "cancel") { await runtime.cancel(); return { settled: true }; }
  throw new Error("unsupported");
}, () => process.exit(0));
runtime = new HostRuntime(boundary, (frame, budget) => wire.confirmed("frame", frame, budget));
`;

export const bearer = "7f3a9c1e5b8d2f4a6c0e9b7d5f3a1c8e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a";

/** A host whose fence notices, by their message, are collected as `fences`. */
export async function runtimeFixture(
  limits: Partial<CursorLimits>,
  store: (frame: CursorEnvelope) => Promise<void>,
  scenario: FakeSdkScenario = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-host-runtime-")));
  const entry = join(root, "host.ts");
  await writeFile(entry, runtimeHost(scenario));
  const fenced = Promise.withResolvers<string>();
  const host = new CursorHost(
    { env: { HOME: root }, entry, generation: () => "gen", limits },
    (frame) => {
      const fence = fenceOf(frame);
      if (fence) fenced.resolve(fence);
      return store(frame);
    },
  );
  const stderr: string[] = [];
  const watchers: { line: string; resolve(): void }[] = [];
  host.process.stderr.on("line", (line: string) => {
    stderr.push(line);
    for (const watcher of watchers) if (watcher.line === line) watcher.resolve();
  });
  return {
    host,
    fenced: fenced.promise,
    /** Lines the fake SDK wrote, such as "sdk-send" and "sdk-cancel". */
    sdkCalls: () => stderr.filter((line) => line.startsWith("sdk-")),
    /** Resolves when the fake SDK writes `line`, or at once if it already has. */
    reached(line: string) {
      if (stderr.includes(line)) return Promise.resolve();
      const reached = Promise.withResolvers<void>();
      watchers.push({ line, resolve: reached.resolve });
      return reached.promise;
    },
    /** Waits for the child to boot, past any short request deadline under test. */
    ping: () => host.request("ping", undefined, 15_000),
    open: (mcp?: { url: string; bearer: string }) =>
      host.request("open", {
        cwd: root,
        threadId: "host-runtime",
        generation: "gen",
        policy: "full-access",
        limits: Limits.parse(limits),
        ...(mcp ? { mcp } : {}),
      }),
    send: (operationId: string) =>
      host.request("send", { operationId, segment: 0, input: [{ type: "text", text: "go" }] }),
    cancel: () => host.request("cancel"),
    async [Symbol.asyncDispose]() {
      await host.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fenceOf(frame: CursorEnvelope): string | undefined {
  const body = frame.body;
  return frame.kind === "error" &&
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    body.code === "boundary_overflow" &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : undefined;
}
