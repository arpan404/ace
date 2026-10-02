import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";
import { stubHandler } from "./commands.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
  vi.useRealTimers();
});
describe("connection ownership", () => {
  it("releases thread subscriptions on socket close so an unowned view stops updating", async () => {
    const { promise: disconnected, resolve: notify } = Promise.withResolvers<void>();
    const f = await fixture({ onDisconnect: () => notify() });
    cleanups.push(() => f.close());
    const view = f.store.acquireThread(f.thread.id);
    const client = await f.connect();
    await client.next();
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "thread", threadId: f.thread.id },
    });
    await client.next();
    await client.close();
    await disconnected;
    f.store.releaseThread(f.thread.id);
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "After disconnect" }]);
    expect(view.thread.title).toBe(f.thread.title);
    const fresh = f.store.acquireThread(f.thread.id);
    expect(fresh.thread.title).toBe("After disconnect");
    f.store.releaseThread(f.thread.id);
  });
  it("caps subscriptions at 64 and frees a slot after unsubscribe", async () => {
    const f = await fixture();
    cleanups.push(() => f.close());
    const client = await f.connect();
    await client.next();
    for (let i = 0; i < 64; i++) {
      client.send({ type: "subscribe", subscriptionId: String(i), scope: { kind: "threads" } });
      expect((await client.next()).type).toBe("snapshot");
    }
    client.send({ type: "subscribe", subscriptionId: "extra", scope: { kind: "threads" } });
    expect(await client.next()).toMatchObject({ type: "error", code: "subscription_limit" });
    client.send({ type: "unsubscribe", subscriptionId: "0" });
    client.send({ type: "subscribe", subscriptionId: "extra", scope: { kind: "threads" } });
    expect((await client.next()).type).toBe("snapshot");
  });
  it("resets the idle deadline on activity rather than closing an active socket", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const f = await fixture({ idleTimeoutMs: 100 });
    cleanups.push(() => f.close());
    const client = await f.connect();
    await client.next();
    vi.advanceTimersByTime(90);
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    vi.advanceTimersByTime(60);
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    const closed = once(client.socket, "close");
    vi.advanceTimersByTime(151);
    expect((await closed)[0]).toBe(4008);
  });
  it("returns thread_not_found for archive without appending an effect", async () => {
    const f = await fixture();
    cleanups.push(() => f.close());
    const client = await f.connect();
    await client.next();
    client.send({
      type: "command",
      command: Command.parse({
        id: "missing",
        deviceId: "device",
        payload: { type: "thread.archive", threadId: ThreadId.parse("missing") },
      }),
    });
    expect(await client.next()).toEqual({
      type: "commandResult",
      commandId: "missing",
      ok: false,
      error: "thread_not_found",
    });
    expect(f.store.headSeq()).toBe(1);
  });
  it("keeps development creation disabled in the production handler", async () => {
    const f = await fixture({ handler: stubHandler() });
    cleanups.push(() => f.close());
    const client = await f.connect();
    await client.next();
    client.send({
      type: "command",
      command: Command.parse({
        id: "create",
        deviceId: "device",
        payload: {
          type: "thread.create",
          workspaceId: f.workspace,
          provider: "codex",
          input: [{ type: "text", text: "Hi" }],
        },
      }),
    });
    expect(await client.next()).toEqual({
      type: "commandResult",
      commandId: "create",
      ok: false,
      error: "not_implemented",
    });
    expect(f.store.headSeq()).toBe(1);
    expect(f.store.listThreads().map((t) => t.id)).toEqual([f.thread.id]);
  });
});
