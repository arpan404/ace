// Non-gating. Per-delta host cost over a fake SDK (no Cursor): a run streams `count` text deltas
// through the real HostRuntime; each stored frame costs one JSON round trip, as IPC would.
// Reports deltas per stored frame (daemon acks and SQLite commits) and microseconds per delta.
import * as sdk from "@cursor/sdk";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostRuntime, CursorLimitsSchema, unbatch, type RuntimeSdkBoundary } from "../src/index.ts";

const count = Number(process.argv[2] ?? 20000);
/** Milliseconds between tokens, as a model streams them; 0 streams as fast as possible. */
const gapMs = Number(process.argv[3] ?? 0);
const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-frames-bench-")));
let stored = 0;
const finished = Promise.withResolvers<void>();
const agent = {
  agentId: "agent",
  async [Symbol.asyncDispose]() {},
  async send(
    _input: unknown,
    options?: { onDelta?: (event: { update: unknown }) => Promise<void> },
  ) {
    return {
      id: "run",
      async *stream() {
        for (let index = 0; index < count; index++) {
          if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
          await options?.onDelta?.({ update: { type: "text-delta", text: "token " } });
          yield { type: "assistant" };
        }
      },
      async wait() {
        return { id: "run", status: "finished" as const };
      },
      async cancel() {},
    };
  },
};
const boundary = {
  ...sdk,
  Cursor: { auth: { status: async () => ({ status: "logged-in" }) } },
  Agent: { create: async () => agent, resume: async () => agent, cancelRun: async () => {} },
} as unknown as RuntimeSdkBoundary;
const host = new HostRuntime(
  boundary,
  async (frame) => {
    JSON.parse(JSON.stringify(frame));
    stored++;
    if (unbatch(frame).some((inner) => inner.kind === "result")) finished.resolve();
  },
  () => home,
  {},
);
await host.open({
  threadId: "bench",
  cwd: home,
  generation: "bench",
  policy: "full-access",
  limits: CursorLimitsSchema.parse({}),
});
const before = stored;
const start = performance.now();
await host.send({ operationId: "op", segment: 0, input: [{ type: "text", text: "go" }] });
await finished.promise;
const elapsed = performance.now() - start;
await host.close();
await rm(home, { recursive: true, force: true });
console.log(
  JSON.stringify({
    deltas: count,
    storedFrames: stored - before,
    deltasPerStoredFrame: Number((count / (stored - before)).toFixed(1)),
    microsecondsPerDelta: Number(((elapsed * 1000) / count).toFixed(2)),
  }),
);
