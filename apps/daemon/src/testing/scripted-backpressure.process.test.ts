import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { Command } from "@ace/protocol";
import { scriptedProvider } from "../../bench/scripted.ts";
import { ManualClock } from "../engine/test-support.ts";

// Real SQLite and daemon entry, without any installed provider executable.
test("the measurement provider starts under default permissions and persists its scripted stream", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-perf-script-"));
  const store = new Store(join(home, "events.sqlite"));
  const provider = scriptedProvider();
  const registry = new AdapterRegistry();
  registry.register(provider.adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
  const engine = new Engine(store, { registry });
  try {
    await engine.ready();
    const workspaceId = store.createWorkspace(home, "Measurement");
    const command = Command.parse({
      id: "start-script",
      deviceId: "perf",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "codex",
        input: [{ type: "text", text: "script" }],
      },
    });
    const result = store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, store),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.threadId) throw new Error("Missing measurement thread");
    await engine.flush();
    await provider.emit(result.threadId, 42);
    await engine.flush();
    const events = store.readEvents({ afterSeq: 0, threadId: result.threadId, limit: 256 });
    const delta = events.find((event) => event.payload.type === "item.delta");
    if (delta?.payload.type !== "item.delta") throw new Error("Missing scripted stream");
    expect(JSON.parse(delta.payload.append)).toMatchObject({ index: 42 });
    await provider.finish(result.threadId);
    await engine.flush();
    expect(store.getThread(result.threadId)?.status.state).toBe("done");
  } finally {
    await engine.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("an adapter awaiting each frame receives every live delta while persisted deltas compact", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-perf-ack-"));
  const store = new Store(join(home, "events.sqlite"));
  const provider = scriptedProvider();
  const registry = new AdapterRegistry();
  registry.register(provider.adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
  const clock = new ManualClock();
  const engine = new Engine(store, { registry, clock, batchScheduler: clock });
  try {
    const workspaceId = store.createWorkspace(home, "Fixture");
    const command = Command.parse({
      id: "stream",
      deviceId: "fixture",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "codex",
        input: [{ type: "text", text: "fixture" }],
      },
    });
    const result = engine.handler.handle(command, store);
    if (!result.threadId) throw new Error("Missing thread");
    await engine.flush();
    const live: string[] = [];
    const stop = store.subscribe((events) => {
      for (const event of events)
        if (event.payload.type === "item.delta") live.push(event.payload.append);
    });
    try {
      for (let index = 0; index < 100; index++) {
        const admitted = provider.emit(result.threadId, index);
        clock.advance(clock.now() + 1);
        await admitted;
      }
    } finally {
      stop();
    }
    expect(live).toHaveLength(100);
    expect(live.map((append) => JSON.parse(append).index)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    // Batching bounds are covered by delta-batching.process.test.ts.
    const deltas = store
      .readEvents({ afterSeq: 0, limit: 1000 })
      .filter((event) => event.payload.type === "item.delta");
    expect(
      deltas
        .map((event) => (event.payload.type === "item.delta" ? event.payload.append : ""))
        .join(""),
    ).toBe(live.join(""));
  } finally {
    await engine.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
