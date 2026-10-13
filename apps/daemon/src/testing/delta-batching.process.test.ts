import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store, Engine, AdapterRegistry } from "@ace/daemon";
import { Command } from "@ace/protocol";
import { scriptedProvider } from "../../bench/scripted.ts";
import { ManualClock } from "../engine/test-support.ts";

// Real SQLite: each store publication is exactly one committed transaction.
test("a burst of streaming deltas commits in a few ordered transactions, each acknowledged only after commit", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-delta-batch-"));
  const store = new Store(join(home, "events.sqlite"));
  const provider = scriptedProvider();
  const registry = new AdapterRegistry();
  registry.register(provider.adapter, { installed: true, auth: "logged_in", loginHint: "unused" });
  const clock = new ManualClock();
  const engine = new Engine(store, { registry, clock, batchScheduler: clock });
  try {
    const workspaceId = store.createWorkspace(home, "Fixture");
    const command = Command.parse({
      id: "burst",
      deviceId: "fixture",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "codex",
        input: [{ type: "text", text: "fixture" }],
      },
    });
    const result = engine.handler.handle(command, store);
    const threadId = result.threadId;
    if (!threadId) throw new Error("Missing thread");
    await engine.flush();
    const deltaText = () =>
      store
        .readEvents({ afterSeq: 0, threadId, limit: 10_000 })
        .flatMap((event) => (event.payload.type === "item.delta" ? [event.payload.append] : []))
        .join("");
    let transactions = 0;
    store.subscribe((events) => {
      if (events.some((event) => event.payload.type === "item.delta")) transactions++;
    });
    const count = 1000;
    const unacknowledged: number[] = [];
    const acknowledgements = Array.from({ length: count }, (_, index) =>
      provider.emit(threadId, index).then(() => {
        if (!deltaText().includes(`"index":${index},`)) unacknowledged.push(index);
      }),
    );
    // Nothing commits per frame: the burst waits for the batch window or a full batch.
    clock.advance(clock.now() + 1);
    await Promise.all(acknowledgements);
    expect(transactions).toBeGreaterThan(0);
    expect(transactions).toBeLessThanOrEqual(Math.ceil(count / 256) + 1);
    expect(unacknowledged).toEqual([]);
    const order = [...deltaText().matchAll(/"index":(\d+),/g)].map((match) => Number(match[1]));
    expect(order).toEqual(Array.from({ length: count }, (_, index) => index));
  } finally {
    await engine.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
