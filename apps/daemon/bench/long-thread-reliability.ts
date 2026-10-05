import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { WebSocket } from "ws";
import { Store, Engine, AdapterRegistry } from "../src/index.ts";
import { startServer } from "../src/server.ts";
import { publishHistory } from "../src/history-publisher.ts";
import { openHistory } from "@ace/history-import";
import { ThreadId, AgentId, Command, DeviceId } from "@ace/protocol";
import { Client, webSocketTransport } from "@ace/client";
import { syntheticProvider } from "../src/testing/long-thread-provider.ts";

const option = (key: string, fallback: number) =>
  z
    .number()
    .int()
    .nonnegative()
    .parse(
      Number(process.argv.find((arg) => arg.startsWith(`--${key}=`))?.split("=")[1] ?? fallback),
    );
const long = process.argv.includes("--long");
const items = option("items", long ? 1_000_000 : 10_000);
const cycles = option("cycles", long ? 12 : 4);
const duration = option("duration-ms", long ? 172_800_000 : 0);
const benchmarkStarted = performance.now();
const phases = { itemsMs: 0, pendingApprovalsMs: 0 };
let report: Record<string, unknown> | undefined;
const root = await mkdtemp(join(tmpdir(), "ace-long-thread-"));
const path = join(root, "events.sqlite");
const store = new Store(path);
const provider = syntheticProvider();
const registry = new AdapterRegistry();
registry.register(provider.adapter, {
  installed: true,
  auth: "logged_in",
  loginHint: "synthetic only",
});
const errors: unknown[] = [];
const engine = new Engine(store, {
  registry,
  onError: (error) => errors.push(error),
  silenceMs: 1_000_000,
});
const workspace = store.createWorkspace(root, "Synthetic");
const token = "a".repeat(64);
const server = await startServer({
  port: 0,
  token,
  hostId: "synthetic",
  store,
  handler: engine.handler,
  engine,
});
let nextId = 0;
let snapshotCount = 0;
let largestFrame = 0;
const messageType = z.object({ type: z.string(), done: z.boolean().optional() });
const client = new Client({
  deviceId: DeviceId.parse("soak"),
  credential: async () => token,
  id: () => `client-${++nextId}`,
  random: () => 0,
  storage: { load: async () => null, save: async () => {} },
  scheduler: {
    set(delay, callback) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  },
  transport: () => {
    const transport = webSocketTransport(() => new WebSocket(server.url));
    return {
      ...transport,
      open(events) {
        transport.open({
          ...events,
          message(text) {
            largestFrame = Math.max(largestFrame, Buffer.byteLength(text));
            const message = messageType.parse(JSON.parse(text));
            if (message.type === "snapshot" || (message.type === "snapshot.part" && message.done))
              snapshotCount++;
            events.message(text);
          },
        });
      },
    };
  },
});
let history: Awaited<ReturnType<typeof openHistory>> | undefined;
async function waitFor(predicate: () => boolean) {
  const timeout = performance.now() + 15000;
  while (!predicate()) {
    assert(performance.now() < timeout, "soak operation timed out");
    await setImmediate();
  }
}
async function measureWrites(append: string) {
  store.statement("PRAGMA wal_autocheckpoint=0").get();
  store.statement("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const initialWal = statSync(path + "-wal").size;
  const beforeWrites = Number(store.statement("SELECT total_changes() AS n").get()?.n);
  for (let i = 0; i < 1000; i++)
    void provider.frame({ kind: "delta", append: append }).catch((error) => errors.push(error));
  await engine.flush();
  const walBytesPerDelta = (statSync(path + "-wal").size - initialWal) / 1000;
  const rowsPerDelta =
    (Number(store.statement("SELECT total_changes() AS n").get()?.n) - beforeWrites) / 1000;
  assert(walBytesPerDelta < 2048, `WAL write budget exceeded: ${walBytesPerDelta}`);
  assert(rowsPerDelta < 1, `row write budget exceeded: ${rowsPerDelta}`);
  store.statement("PRAGMA wal_autocheckpoint=256").get();
  return { walBytesPerDelta, rowsPerDelta };
}
const samples: {
  rss: number;
  heap: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}[] = [];
let baseline: { rss: number; heap: number } | undefined;
try {
  const command = Command.parse({
    id: "create",
    deviceId: "soak",
    payload: {
      type: "thread.create",
      workspaceId: workspace,
      provider: "codex",
      input: [{ type: "text", text: "synthetic" }],
    },
  });
  const result = store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, store),
  );
  assert(result.ok && result.threadId);
  const id = result.threadId;
  await engine.flush();
  console.error("seed items");
  const itemsStarted = performance.now();
  for (let first = 0; first < items; first += 128) {
    const committed = provider.frame({ kind: "items", first, count: Math.min(128, items - first) });
    await engine.flush();
    await committed;
  }
  phases.itemsMs = performance.now() - itemsStarted;
  console.error("seed approvals");
  for (let first = 0; first < 5000; first += 128) {
    const committed = provider.frame({
      kind: "approvals",
      first,
      count: Math.min(128, 5000 - first),
    });
    await engine.flush();
    await committed;
  }
  let committed = provider.frame({ kind: "children", count: 48 });
  await engine.flush();
  await committed;
  committed = provider.frame({ kind: "delta", append: "seed" });
  await engine.flush();
  await committed;
  const snapshotBytes = Buffer.byteLength(JSON.stringify(store.snapshotThread(id)));
  assert(snapshotBytes < 1024 * 1024, "snapshot grew with history");
  await client.start();
  await waitFor(() => client.state === "ready");
  const subscription = client.thread(id);
  await waitFor(() => subscription.store.cursor !== undefined);
  // Create an actual history archive and publish it while synthetic stdout is stalled.
  const home = join(root, "provider-home");
  await mkdir(join(home, "sessions/2026/01/01"), { recursive: true });
  const records = [
    { type: "session_meta", payload: { id: "11111111-1111-4111-8111-111111111111", cwd: root } },
    ...Array.from({ length: 512 }, (_, i) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `import ${i}` }],
      },
    })),
  ];
  await writeFile(
    join(home, "sessions/2026/01/01/rollout.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  const archivePath = join(root, "history.sqlite");
  history = await openHistory({
    indexPath: archivePath,
    instances: [{ id: "synthetic-account", provider: "codex", homeDir: home }],
  });
  await history.scan();
  const source = (await history.list({ type: "history.list", cwd: root })).sessions[0];
  assert(source);
  const imported = ThreadId.parse("imported");
  await history.importSession({
    sourceId: source.id,
    threadId: imported,
    workspaceId: workspace,
    agentId: AgentId.parse("import-root"),
    at: Date.now(),
  });
  console.error("import and burst");
  const publishing = publishHistory(
    store,
    path,
    archivePath,
    imported,
    Date.now(),
    new AbortController().signal,
  );
  const burst = provider.burst();
  await publishing;
  console.error("published");
  await burst;
  console.error("burst complete");
  await engine.flush();
  assert(store.getThread(imported)?.imported);
  const { walBytesPerDelta, rowsPerDelta } = await measureWrites("x");
  console.error("seed pending approvals");
  const pendingStarted = performance.now();
  for (let first = 5000; first < 10000; first += 128) {
    const ack = provider.frame({
      kind: "pending_approvals",
      first,
      count: Math.min(128, 10000 - first),
    });
    await engine.flush();
    await ack;
  }
  phases.pendingApprovalsMs = performance.now() - pendingStarted;
  const pendingView = store.snapshotThread(id);
  assert.equal(
    Object.values(pendingView.interactions).filter((interaction) => interaction.state === "pending")
      .length,
    5000,
  );
  const pendingSnapshotBytes = Buffer.byteLength(JSON.stringify(pendingView));
  assert(pendingSnapshotBytes < 4 * 1024 * 1024, "pending snapshot grew with history");
  const pendingWrites = await measureWrites("p");
  console.error(
    "write budgets",
    JSON.stringify({
      snapshotBytes,
      pendingSnapshotBytes,
      walBytesPerDelta,
      rowsPerDelta,
      pendingWrites,
    }),
  );
  const started = performance.now();
  let expectedStream = 4 + provider.burstDeltas + 2000;
  let cycle = 0;
  let added = 0;
  while (cycle < cycles || performance.now() - started < duration) {
    console.error(`cycle ${cycle}`);
    client.networkOnline(false);
    for (let part = 0; part < 48; part++) {
      const ack = provider.frame({ kind: "items", first: items + added, count: 128 });
      await engine.flush();
      await ack;
      added += 128;
    }
    await provider.burst();
    await engine.flush();
    expectedStream += provider.burstDeltas;
    client.networkOnline(true);
    await waitFor(() => client.state === "ready");
    const head = store.headSeq();
    await waitFor(() => subscription.store.cursor === head);
    assert.equal(subscription.store.error, undefined);
    assert.equal(errors.length, 0, errors.map(String).join("\n"));
    assert.equal(
      Number(
        store
          .statement(
            "SELECT COUNT(*) AS n FROM engine_state_records WHERE thread_id=? AND section='items' AND key LIKE 'history:%'",
          )
          .get(id)?.n,
      ),
      items + added,
      "lost or duplicated items",
    );
    const metadata = store
      .statement(
        "SELECT value FROM engine_state_records WHERE thread_id=? AND section='items' AND key='stream'",
      )
      .get(id);
    assert(metadata);
    const streamId = z.object({ id: z.string() }).parse(JSON.parse(String(metadata.value))).id;
    const created = Number(
      store
        .statement("SELECT created_seq FROM item_heads WHERE thread_id=? AND id=?")
        .get(id, streamId)?.created_seq,
    );
    const stream = store.readItemPage(id, created + 1, 1).items[0];
    assert(stream?.type === "message");
    const part = stream.parts.find((candidate) => candidate.type === "text");
    assert(part?.type === "text");
    assert.equal(
      part.source?.bytes ?? part.text.length * 2,
      expectedStream * 2,
      "lost or duplicated deltas",
    );
    // Await collection and compaction before measuring retained memory, not V8's
    // variable reservation for the preceding burst. Reachable native buffers remain charged.
    await globalThis.gc?.({ type: "major", execution: "async", flavor: "last-resort" });
    const memory = process.memoryUsage();
    const retained = {
      rss: memory.rss,
      heap: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    };
    samples.push(retained);
    // Keep the original warm baseline after the telemetry ring rotates over days.
    if (cycle === 1) baseline = retained;
    console.error("retained memory", JSON.stringify({ cycle, baseline, ...retained }));
    if (baseline) {
      assert(retained.heap - baseline.heap < 16 * 1024 * 1024, "retained heap grew");
      assert(retained.rss - baseline.rss < 64 * 1024 * 1024, "retained RSS grew");
    }
    // Keep telemetry bounded over multiple days.
    if (samples.length > 128) samples.shift();
    cycle++;
    if (duration) await sleep(60000);
  }
  const first = baseline ?? samples[0],
    last = samples.at(-1);
  assert(first && last);
  assert(last.heap - first.heap < 16 * 1024 * 1024, "retained heap grew");
  assert(last.rss - first.rss < 64 * 1024 * 1024, "retained RSS grew");
  assert(largestFrame < 2 * 1024 * 1024, "oversized client frame");
  assert(snapshotCount >= cycles, "reconnect did not fall back to snapshots");
  report = {
    items,
    approvals: 5000,
    subagents: 48,
    cycles: cycle,
    snapshotBytes,
    pendingApprovals: 5000,
    pendingSnapshotBytes,
    pendingWrites,
    largestFrame,
    snapshotCount,
    walBytesPerDelta,
    rowsPerDelta,
    first,
    last,
    samples,
    elapsedMs: performance.now() - started,
    errors: errors.length,
  };
  subscription.release();
} catch (error) {
  // Publish failure before cleanup so a later subprocess deadline cannot hide it.
  console.error(JSON.stringify({ type: "acceptance.failed", error: String(error) }));
  throw error;
} finally {
  await client.close();
  await server.close();
  await engine.close();
  await history?.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
if (report)
  console.log(
    JSON.stringify({ ...report, phases, totalElapsedMs: performance.now() - benchmarkStarted }),
  );
