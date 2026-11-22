// Test support: the real Cursor host process (real HostRuntime behind the real wire) over a fake
// SDK and a real SDK SQLite store, as a daemon's Cursor adapter opens it. No provider is contacted.
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CursorTranslator,
  cursorCapabilities,
  checkpointDirectory,
  openCursorSession,
  openSdkCheckpointStore,
} from "@ace/adapter-cursor";
import { markStoreUnusable } from "@ace/adapter-cursor/store-fence";
import type { ProviderAdapter } from "@ace/engine-api";
import { ThreadId } from "@ace/protocol";

export const threadId = ThreadId.parse("crashed-thread");
const adapterEntry = fileURLToPath(import.meta.resolve("@ace/adapter-cursor"));
const sdkDist = join(dirname(createRequire(adapterEntry).resolve("@cursor/sdk")), "..");

/** Writes the host entry: the real runtime and wire over a fake SDK that never calls Cursor. */
export async function writeHostEntry(path: string): Promise<string> {
  await writeFile(
    path,
    `
const sdk = await import(${JSON.stringify(pathToFileURL(join(sdkDist, process.versions.bun ? "bundled/index.js" : "esm/index.js")).href)});
const { hostWire } = await import(${JSON.stringify(import.meta.resolve("@ace/adapter-cursor/host-wire"))});
const { HostRuntime } = await import(${JSON.stringify(import.meta.resolve("@ace/adapter-cursor"))});
const { appendFileSync } = await import("node:fs");
const agent = {
  agentId: "native-agent",
  async [Symbol.asyncDispose]() {},
  async send(input) {
    appendFileSync(process.env.ACE_TEST_SENDS, JSON.stringify(input) + "\\n");
    const run = { id: "run-" + Date.now(), async *stream() {}, async wait() { return { id: run.id, status: "finished" }; }, async cancel() {} };
    return run;
  },
};
const boundary = {
  ...sdk,
  Cursor: { ...sdk.Cursor, auth: { ...sdk.Cursor.auth, async status() { return { status: "logged-in" }; } } },
  Agent: { async create() { return agent; }, async resume() { return agent; }, async cancelRun() {} },
  async sandboxSupport() { return { supported: true, async release() {} }; },
};
let runtime;
const wire = hostWire(async (method, params) => {
  if (method === "open") return runtime.open(params);
  if (method === "send") return runtime.send(params);
  if (method === "cancel") { await runtime.cancel(); return { settled: true }; }
  if (method === "close") return { closed: true };
  throw new Error("unsupported");
}, () => process.exit(0));
runtime = new HostRuntime(boundary, (frame, budget) => wire.confirmed("frame", frame, budget));
`,
  );
  return path;
}

const message = (text: string) => ({
  schemaVersion: 1,
  type: "sdk_message",
  message: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
});
// The store is SQLite, so the JSONL constructor is never used.
const sdkStub = { JsonlLocalAgentStore: Object } as never;

/** Cursor's own record of the crashed thread: its agent and one run, as the SDK leaves them. */
export async function seedStore(
  home: string,
  cwd: string,
  run: {
    status: "running" | "finished";
    result?: string;
    texts: string[];
    createdAt: number;
    /** No run at all: the SDK never created one. */
    none?: boolean;
  },
) {
  const owned = await openSdkCheckpointStore(sdkStub, checkpointDirectory(home, threadId), cwd);
  const blobId = "ab".repeat(32);
  await owned.store.agents.create({
    agent: {
      agentId: "native-agent",
      cwd,
      status: "idle",
      createdAt: 1,
      updatedAt: run.createdAt,
      ...(run.status === "running" ? { activeRunId: "run-1" } : {}),
      latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId },
    } as never,
  });
  await owned.store.checkpoints.create({
    agentId: "native-agent",
    blobId,
    data: new Uint8Array([1]),
  });
  if (run.none) {
    await owned.close();
    return;
  }
  await owned.store.runs.create({
    run: {
      runId: "run-1",
      agentId: "native-agent",
      turnNumber: 1,
      status: run.status,
      ...(run.result ? { result: run.result } : {}),
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
    },
  });
  for (const text of run.texts)
    await owned.store.runEvents.append({
      runId: "run-1",
      eventType: "run_stream_event",
      payload: message(text),
    });
  await owned.close();
}

/**
 * The daemon's Cursor adapter, opening the real host with `entry` under `home`. `committed`
 * hears each frame once the daemon has committed it, before the host is told so.
 */
export function realHostAdapter(
  entry: string,
  home: string,
  sends: string,
  committed: (kind: string) => Promise<void> = async () => {},
): ProviderAdapter {
  return {
    provider: "cursor",
    backend: "cursor-sdk",
    capabilities: () => cursorCapabilities,
    createTranslator: (init) => new CursorTranslator(init),
    openSession: (context) =>
      openCursorSession(
        {
          ...context,
          onFrame: async (frame) => {
            await context.onFrame(frame);
            const data = frame.data as { kind?: unknown } | undefined;
            if (typeof data?.kind === "string") await committed(data.kind);
          },
        },
        {
          instanceId: "account-a",
          entry,
          env: { HOME: home, ACE_TEST_SENDS: sends },
          policy: "full-access",
        },
      ).catch((error: unknown) => {
        throw markStoreUnusable(error);
      }),
  } as ProviderAdapter;
}
