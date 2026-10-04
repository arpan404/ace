import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Engine, AdapterRegistry } from "../src/index.ts";
import { Command } from "@ace/protocol";
import { syntheticProvider } from "../src/testing/long-thread-provider.ts";
const home = await mkdtemp(join(tmpdir(), "ace-snapshot-size-"));
const store = new Store(":memory:");
const provider = syntheticProvider();
const registry = new AdapterRegistry();
registry.register(provider.adapter, { installed: true, auth: "logged_in", loginHint: "offline" });
const engine = new Engine(store, { registry });
try {
  const workspace = store.createWorkspace(home, "Snapshot");
  const command = Command.parse({
    id: "create",
    deviceId: "fixture",
    payload: {
      type: "thread.create",
      provider: "codex",
      workspaceId: workspace,
      input: [{ type: "text", text: "fixture" }],
    },
  });
  const result = engine.handler.handle(command, store);
  if (!result.threadId) throw new Error("Missing thread");
  await engine.flush();
  for (let first = 0; first < 10_000; first += 128) {
    const ack = provider.frame({ kind: "items", first, count: Math.min(128, 10_000 - first) });
    await engine.flush();
    await ack;
  }
  for (let first = 0; first < 5000; first += 128) {
    const ack = provider.frame({ kind: "approvals", first, count: Math.min(128, 5000 - first) });
    await engine.flush();
    await ack;
  }
  const ack = provider.frame({ kind: "children", count: 48 });
  await engine.flush();
  await ack;
  const snapshot = store.snapshotThread(result.threadId);
  console.log(
    JSON.stringify({
      items: 10_000,
      approvals: 5000,
      subagents: 48,
      bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      retainedApprovals: Object.keys(snapshot.interactions).length,
    }),
  );
} finally {
  await engine.close();
  await store.close();
  await rm(home, { recursive: true, force: true });
}
