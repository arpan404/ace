// Real edges: a killed daemon process, the real Cursor host process over a fake SDK, and the
// SDK's own SQLite store held by another writer. No provider is contacted.
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import {
  CursorTranslator,
  cursorCapabilities,
  checkpointDirectory,
  openCursorSession,
  openSdkCheckpointStore,
} from "@ace/adapter-cursor";
import { markStoreUnusable } from "@ace/adapter-cursor/store-fence";
import { ThreadId } from "@ace/protocol";

const threadId = ThreadId.parse("crashed-thread");
const adapterEntry = fileURLToPath(import.meta.resolve("@ace/adapter-cursor"));
const sdkDist = join(dirname(createRequire(adapterEntry).resolve("@cursor/sdk")), "..");

/** The real runtime behind the real wire, as host-entry wires them, over a fake SDK. */
const hostEntry = `
const sdk = await import(${JSON.stringify(pathToFileURL(join(sdkDist, process.versions.bun ? "bundled/index.js" : "esm/index.js")).href)});
const { hostWire } = await import(${JSON.stringify(import.meta.resolve("@ace/adapter-cursor/host-wire"))});
const { HostRuntime } = await import(${JSON.stringify(import.meta.resolve("@ace/adapter-cursor"))});
const agent = { agentId: "native-agent", async [Symbol.asyncDispose]() {}, async send() { throw new Error("no send"); } };
const boundary = {
  ...sdk,
  Cursor: { ...sdk.Cursor, auth: { ...sdk.Cursor.auth, async status() { return { status: "logged-in" }; } } },
  Agent: { async create() { return agent; }, async resume() { return agent; }, async cancelRun() {} },
  async sandboxSupport() { return { supported: true, async release() {} }; },
};
let runtime;
const wire = hostWire(async (method, params) => {
  if (method === "open") return runtime.open(params);
  if (method === "close") return { closed: true };
  throw new Error("unsupported");
}, () => process.exit(0));
runtime = new HostRuntime(boundary, (frame, budget) => wire.confirmed("frame", frame, budget));
`;

/** Cursor's own record of the cut-off run: it finished, with more text than ace saw. */
async function seedStore(home: string, cwd: string) {
  const owned = await openSdkCheckpointStore(sdkStub, checkpointDirectory(home, threadId), cwd);
  const blobId = "ab".repeat(32);
  await owned.store.agents.create({
    agent: {
      agentId: "native-agent",
      cwd,
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
      latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId },
    } as never,
  });
  await owned.store.checkpoints.create({
    agentId: "native-agent",
    blobId,
    data: new Uint8Array([1]),
  });
  await owned.store.runs.create({
    run: {
      runId: "run-1",
      agentId: "native-agent",
      turnNumber: 1,
      status: "finished",
      result: "before and after",
      createdAt: 1,
      updatedAt: 1,
    },
  });
  const message = (text: string) => ({
    schemaVersion: 1,
    type: "sdk_message",
    message: {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  });
  // The daemon's record reaches event 1: the rest is what it missed.
  await owned.store.runEvents.append({
    runId: "run-1",
    eventType: "run_stream_event",
    payload: message("before"),
  });
  await owned.store.runEvents.append({
    runId: "run-1",
    eventType: "run_stream_event",
    payload: message(" and after"),
  });
  await owned.close();
}
const sdkStub = { JsonlLocalAgentStore: class {} } as never;

it("a Cursor store another process holds at reconcile keeps the turn working until it reads, then ends as Cursor's store says", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-busy-store-")));
  const path = join(root, "state.sqlite");
  const child = fork(
    new URL("./cursor-recovery-child.ts", import.meta.url),
    [path, root, "admitted"],
    {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exit = once(child, "exit");
  try {
    await once(child, "message");
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
  const home = join(root, "home");
  await seedStore(home, root);
  const entry = join(root, "host.ts");
  await writeFile(entry, hostEntry);
  // Another process's writer holds the store.
  const holder = new DatabaseSync(join(checkpointDirectory(home, threadId), "index.db"));
  holder.exec("BEGIN IMMEDIATE");
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    holder.exec("ROLLBACK");
    holder.close();
  };
  const store = new Store(path);
  const registry = new AdapterRegistry();
  const attempts: string[] = [];
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      openSession: (context) =>
        openCursorSession(context, {
          instanceId: "account-a",
          entry,
          env: { HOME: home },
          policy: "full-access",
        }).catch((error: unknown) => {
          // What the thread shows while the store is held, then the holder lets go.
          attempts.push(store.getThread(threadId)?.status.state ?? "missing");
          release();
          throw markStoreUnusable(error);
        }),
    },
    { installed: true, auth: "logged_in", loginHint: "offline" },
  );
  const engine = new Engine(store, {
    registry,
    selectInstance: () => "account-a",
    cursorReconcileRetryMs: [100, 200, 400],
  });
  try {
    await engine.flush();
    expect(attempts).toEqual(["working"]);
    const runs = store
      .readEvents({ afterSeq: 0, limit: 1000 })
      .flatMap((event) => (event.payload.type === "run.ended" ? [event.payload.state] : []));
    expect(runs).toEqual(["completed"]);
    const answers = store
      .readItems(threadId, store.headSeq() + 1, 200)
      .items.flatMap((item) =>
        item.type === "message" && item.role === "assistant"
          ? [item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")]
          : [],
      );
    expect(answers).toEqual(["before and after"]);
  } finally {
    release();
    await engine.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
