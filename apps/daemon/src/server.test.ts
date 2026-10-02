import { once } from "node:events";
import { Command, Item, ThreadId } from "@ace/protocol";
import { applyEvent } from "@ace/projection";
import { afterEach, describe, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { fixture } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  cleanups.push(() => f.close());
  return f;
}

describe("WebSocket API", () => {
  it("rejects a bad token before any data is sent", async () => {
    const f = await setup();
    const client = await f.connect("wrong");
    const closed = once(client.socket, "close");
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
    expect((await closed)[0]).toBe(4001);
  });
  it("sends a current snapshot, live updates and heartbeat responses", async () => {
    const f = await setup();
    const client = await f.connect();
    expect(await client.next()).toMatchObject({ type: "welcome", headSeq: 1 });
    client.send({
      type: "subscribe",
      subscriptionId: "thread",
      scope: { kind: "thread", threadId: f.thread.id },
    });
    const snapshot = await client.next();
    expect(snapshot).toMatchObject({
      type: "snapshot",
      seq: 1,
      view: { thread: { title: f.thread.title } },
    });
    const events = f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Live" }]);
    expect(await client.next()).toEqual({ type: "events", subscriptionId: "thread", events });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.send({ type: "unsubscribe", subscriptionId: "thread" });
    client.send({ type: "ping" });
    await client.next();
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "After unsubscribe" }]);
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
  });
  it("reconnects with exactly the missed events in host sequence order", async () => {
    const f = await setup();
    const first = await f.connect();
    await first.next();
    first.send({ type: "subscribe", subscriptionId: "s", scope: { kind: "threads" } });
    const snapshot = await first.next();
    if (snapshot.type !== "snapshot") throw new Error("Expected snapshot");
    await first.close();
    const missed = f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", title: "Offline 1" },
      { type: "thread.updated", title: "Offline 2" },
    ]);
    const client = await f.connect();
    await client.next();
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "threads" },
      afterSeq: snapshot.seq,
    });
    expect(await client.next()).toEqual({ type: "events", subscriptionId: "s", events: missed });
    const live = f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Online" }]);
    expect(await client.next()).toEqual({ type: "events", subscriptionId: "s", events: live });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
  });
  it("uses a snapshot when replay exceeds the configured limit", async () => {
    const f = await setup({ replayLimit: 2 });
    f.store.appendEvents(
      f.thread.id,
      Array.from({ length: 3 }, () => ({ type: "thread.updated", title: "Latest" })),
    );
    const client = await f.connect();
    await client.next();
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "threads" },
      afterSeq: 0,
    });
    expect(await client.next()).toMatchObject({
      type: "snapshot",
      seq: 4,
      view: { threads: { [f.thread.id]: { title: "Latest" } } },
    });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
  });
  it("applies duplicate commands once and returns the same result", async () => {
    const f = await setup();
    const client = await f.connect();
    await client.next();
    const command = Command.parse({
      id: "archive",
      deviceId: "device",
      payload: { type: "thread.archive", threadId: f.thread.id },
    });
    client.send({ type: "command", command });
    const first = await client.next();
    client.send({ type: "command", command });
    expect(await client.next()).toEqual(first);
    expect(first).toEqual({ type: "commandResult", commandId: "archive", ok: true });
    expect(f.store.readEvents({ afterSeq: 1, limit: 10 })).toHaveLength(1);
    expect(f.store.getThread(f.thread.id)?.archivedAt).toBeTypeOf("number");
  });
  it("creates dev threads while rejecting unsupported and forged commands", async () => {
    const f = await setup();
    const client = await f.connect();
    await client.next();
    const create = Command.parse({
      id: "create",
      deviceId: "device",
      payload: {
        type: "thread.create",
        workspaceId: f.workspace,
        provider: "codex",
        title: "Created",
        input: [{ type: "text", text: "Hi" }],
      },
    });
    client.send({ type: "command", command: create });
    expect(await client.next()).toMatchObject({ type: "commandResult", ok: true });
    expect(f.store.listThreads().map((t) => t.title)).toContain("Created");
    const unsupported = Command.parse({
      id: "send",
      deviceId: "device",
      payload: {
        type: "thread.send",
        threadId: f.thread.id,
        input: [{ type: "text", text: "Hi" }],
        delivery: "queue",
      },
    });
    client.send({ type: "command", command: unsupported });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      ok: false,
      error: "not_implemented",
    });
    client.send({
      type: "command",
      command: Command.parse({ ...unsupported, id: "forged", deviceId: "different" }),
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "device_mismatch" });
    expect(f.store.headSeq()).toBe(2);
  });
  it("rejects invalid commands and subscriptions without losing the connection", async () => {
    const f = await setup();
    const client = await f.connect();
    await client.next();
    client.socket.send(
      JSON.stringify({ type: "command", command: { payload: { type: "thread.archive" } } }),
    );
    expect(await client.next()).toMatchObject({ type: "error", code: "invalid_message" });
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "thread", threadId: ThreadId.parse("missing") },
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "subscribe_failed" });
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "threads" },
      afterSeq: 100,
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "subscribe_failed" });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    expect(f.store.headSeq()).toBe(1);
  });
  it("advances a thread subscription across interleaved threads without false gaps", async () => {
    const f = await setup();
    const client = await f.connect();
    await client.next();
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "thread", threadId: f.thread.id },
    });
    const snapshot = await client.next();
    if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread")
      throw new Error("Expected thread snapshot");
    const other = createDevThread(f.store, f.workspace, "Other");
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Mine" }]);
    for (let i = 0; i < 2; i++) {
      const batch = await client.next();
      if (batch.type !== "events") throw new Error("Expected events");
      for (const event of batch.events)
        expect(applyEvent(snapshot.view, event).kind).toBe("applied");
    }
    expect(snapshot.view.thread.title).toBe("Mine");
    expect(snapshot.view.seq).toBe(3);
    expect(snapshot.view.thread.id).not.toBe(other.id);
  });
  it("moves from replay or snapshot to live commands without gaps or duplicates", async () => {
    const f = await setup();
    for (const afterSeq of [undefined, 0]) {
      const client = await f.connect();
      await client.next();
      const before = f.store.headSeq();
      client.send({
        type: "subscribe",
        subscriptionId: "race",
        scope: { kind: "thread", threadId: f.thread.id },
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      const command = Command.parse({
        id: `race-${before}`,
        deviceId: "device",
        payload: { type: "thread.archive", threadId: f.thread.id },
      });
      // Consecutive real frames exercise the transition before the client reads replay.
      client.send({ type: "command", command });
      const initial = await client.next();
      if (afterSeq === undefined) expect(initial).toMatchObject({ type: "snapshot", seq: before });
      else {
        if (initial.type !== "events") throw new Error("Expected replay");
        expect(initial.events.map((e) => e.seq)).toEqual(
          Array.from({ length: before }, (_, i) => i + 1),
        );
      }
      const live = await client.next();
      if (live.type !== "events") throw new Error("Expected live command event");
      expect(live.events.map((e) => e.seq)).toEqual([before + 1]);
      expect(await client.next()).toMatchObject({ type: "commandResult", ok: true });
      client.send({ type: "ping" });
      expect(await client.next()).toEqual({ type: "pong" });
      await client.close();
    }
  });
  it("closes idle sockets without a client heartbeat", async () => {
    const f = await setup({ idleTimeoutMs: 20 });
    const client = await f.connect();
    const closed = once(client.socket, "close");
    await client.next();
    expect((await closed)[0]).toBe(4008);
  });
  it("coalesces queued deltas on a real socket and preserves sequence coverage", async () => {
    const f = await setup({ pressure: { softLimit: 0, hardLimit: 32 * 1024 * 1024 } });
    const item = Item.parse({
      id: "i",
      agentId: "a",
      type: "message",
      role: "assistant",
      complete: false,
      createdAt: 1,
      parts: [],
    });
    f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
    const client = await f.connect();
    await client.next();
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "thread", threadId: f.thread.id },
    });
    const snapshot = await client.next();
    if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread")
      throw new Error("Expected thread snapshot");
    client.socket.pause();
    const filler = "X".repeat(4 * 1024 * 1024);
    f.store.appendEvents(f.thread.id, [
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: filler },
    ]);
    f.store.appendEvents(
      f.thread.id,
      ["A", "B", "C"].map((append) => ({
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: "text",
        append,
      })),
    );
    client.socket.resume();
    client.send({ type: "ping" });
    const first = await client.next();
    if (first.type !== "events") throw new Error("Expected initial output");
    for (const event of first.events) applyEvent(snapshot.view, event);
    const batch = await client.next();
    if (batch.type !== "events") throw new Error("Expected deltas");
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ firstSeq: 4, seq: 6, payload: { append: "ABC" } });
    for (const event of batch.events) expect(applyEvent(snapshot.view, event).kind).toBe("applied");
    const projected = snapshot.view.items.i;
    if (projected?.type !== "message") throw new Error("Expected message");
    const part = projected.parts[0];
    if (part?.type !== "text") throw new Error("Expected text");
    expect(part.text.length).toBe(filler.length + 3);
    expect(part.text.endsWith("ABC")).toBe(true);
    expect(await client.next()).toEqual({ type: "pong" });
    expect(f.store.readEvents({ afterSeq: 3, limit: 10 }).map((e) => e.seq)).toEqual([4, 5, 6]);
  });
  it("closes overloaded sockets with a resync code", async () => {
    const f = await setup({ pressure: { softLimit: 0, hardLimit: 0, hardTimeoutMs: 0 } });
    const client = await f.connect();
    await client.next();
    client.send({ type: "subscribe", subscriptionId: "s", scope: { kind: "threads" } });
    await client.next();
    const closed = once(client.socket, "close");
    f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", title: "X".repeat(4 * 1024 * 1024) },
    ]);
    expect((await closed)[0]).toBe(4009);
  });
});
