import { afterEach, expect, test } from "vitest";
import { Agent, HostId, ItemId } from "@ace/protocol";
import { setup, ready, barrier, when, message, agentId } from "./test-support.ts";
import { webSocketTransport, type SocketLike } from "./index.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("invalid read input rejects with a typed error without sending a frame", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  const count = faults.sent.length;
  const result = client.itemsPage({ threadId: h.thread.id, limit: 0 });
  await expect(result).rejects.toMatchObject({ name: "ClientError", code: "protocol" });
  expect(faults.sent).toHaveLength(count);
});

test("a correlated response of the wrong result type rejects only that request", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "items.page")
      deliver(
        JSON.stringify({
          type: "output.data",
          requestId: event.requestId,
          streamId: "other",
          offset: 0,
          nextOffset: 0,
          bytes: "",
          eof: true,
        }),
      );
    else deliver(frame);
  };
  await expect(client.itemsPage({ threadId: h.thread.id, limit: 1 })).rejects.toMatchObject({
    code: "protocol",
  });
  expect(client.state).toBe("ready");
  faults.incoming = (_event, frame, deliver) => deliver(frame);
  await barrier(client, h.thread.id);
});

test("a reconnect to a different daemon identity becomes fatal before state is replayed", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make();
  await ready(client);
  faults.disconnect();
  faults.incoming = (event, frame, deliver) =>
    deliver(
      event.type === "welcome"
        ? JSON.stringify({ ...event, hostId: HostId.parse("different-daemon") })
        : frame,
    );
  scheduler.advance(125);
  await when(client.connectionState(), (state) => state === "fatal");
  expect(client.error?.code).toBe("protocol");
  expect(faults.sent.filter((frame) => JSON.parse(frame).type === "subscribe")).toHaveLength(0);
});

test("incremental entity overflow fails the affected subscription while other threads stay live", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make({ limits: { entities: 1 } });
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await when(
    store.select(["thread"], (s) => s.thread),
    Boolean,
  );
  const agent = Agent.parse({
    id: agentId,
    threadId: h.thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/",
    status: { state: "working", activity: "thinking" },
    createdAt: 0,
  });
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "agent.created", agent },
    { type: "agent.created", agent: Agent.parse({ ...agent, id: "second" }) },
  ]);
  await barrier(client, h.thread.id);
  expect(store.error?.code).toBe("limit");
  expect(client.state).toBe("ready");
});

test("a snapshot exceeding the wire item budget fails its scope instead of retaining hidden items", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  faults.incoming = (event, frame, deliver) => {
    if (
      event.type !== "snapshot" ||
      event.view.kind !== "thread" ||
      message.type !== "item.created"
    ) {
      deliver(frame);
      return;
    }
    const fixture = message.item;
    const items = Array.from({ length: 201 }, (_, i) => ({
      ...fixture,
      id: ItemId.parse(`hidden-${i}`),
    }));
    deliver(
      JSON.stringify({
        ...event,
        view: {
          ...event.view,
          items: Object.fromEntries(items.map((item) => [item.id, item])),
          itemOrder: [items[0]?.id],
        },
      }),
    );
  };
  const { store } = client.thread(h.thread.id);
  await barrier(client, h.thread.id);
  expect(store.error?.code).toBe("limit");
  expect(store.item("hidden-200")).toBeUndefined();
  expect(client.state).toBe("ready");
});

test("snapshot decoding retains an opaque prototype-named item and its live deltas", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  if (message.type !== "item.created") throw new Error("fixture");
  const id = ItemId.parse("__proto__");
  h.daemon.store.appendEvents(h.thread.id, [{ ...message, item: { ...message.item, id } }]);
  const { client } = h.make();
  await ready(client);
  const { store } = client.thread(h.thread.id);
  await barrier(client, h.thread.id);
  expect(store.item(id)?.id).toBe(id);
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.delta", itemId: id, agentId, field: "text", append: "kept" },
  ]);
  await barrier(client, h.thread.id);
  expect(store.item(id)).toMatchObject({ parts: [{ type: "text", text: "kept" }] });
});

test("a failed thread subscription leaves healthy reads and subscriptions usable", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make();
  await ready(client);
  const failed = client.thread("missing-thread");
  await barrier(client, h.thread.id);
  expect(failed.store.error?.code).toBe("daemon");
  const good = client.thread(h.thread.id);
  await barrier(client, h.thread.id);
  expect(good.store.thread?.id).toBe(h.thread.id);
  expect(client.state).toBe("ready");
});

class Socket implements SocketLike {
  private opens: (() => void)[] = [];
  private closes: ((event: { code: number }) => void)[] = [];
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(
    type: string,
    listener:
      | (() => void)
      | ((event: { data: unknown }) => void)
      | ((event: { code: number }) => void),
  ): void {
    if (type === "open")
      this.opens.push(() => {
        listener({ data: undefined, code: 1006 });
      });
    if (type === "close")
      this.closes.push((event) => {
        listener({ ...event, data: undefined });
      });
  }
  send(_text: string): void {}
  close(): void {}
  opened(): void {
    for (const listener of this.opens) listener();
  }
  closed(): void {
    for (const listener of this.closes) listener({ code: 1006 });
  }
}
test("reopening a WebSocket adapter ignores late events from the previous socket", () => {
  const sockets: Socket[] = [];
  const transport = webSocketTransport(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const results: string[] = [];
  transport.open({
    open: () => results.push("first open"),
    message: () => results.push("first message"),
    close: () => results.push("first close"),
  });
  sockets[0]?.opened();
  transport.open({
    open: () => results.push("second open"),
    message: () => results.push("second message"),
    close: () => results.push("second close"),
  });
  sockets[0]?.closed();
  sockets[0]?.opened();
  sockets[1]?.opened();
  sockets[1]?.closed();
  expect(results).toEqual(["first open", "second open", "second close"]);
});
