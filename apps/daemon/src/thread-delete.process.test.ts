import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, DeviceId, TerminalRequest, Thread, type CommandPayload } from "@ace/protocol";
import { Store } from "./store.ts";
import { startServer } from "./server.ts";
import { stubHandler } from "./commands.ts";
import { Client, token } from "./socket-test-support.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
async function command(client: Client, payload: CommandPayload, id: string, deviceId = "desktop") {
  client.send({ type: "command", command: Command.parse({ id, deviceId, payload }) });
  return client.next();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-delete-owned-"));
  const store = new Store(join(root, "events.sqlite"), undefined, { now: () => 1000 });
  const workspaceId = store.createWorkspace(root, "Shell project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Shell",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000);
  const server = await startServer({
    store,
    port: 0,
    token,
    hostId: "host",
    now: () => 1000,
    handler: stubHandler(),
    workspaceActions: runtime,
    canReadThread: (_device, id) => {
      const value = store.getThread(id);
      return value !== undefined && value.deletedAt === undefined;
    },
  });
  const clients: Client[] = [];
  async function connect(device = "desktop") {
    const client = new Client(server.url);
    clients.push(client);
    await once(client.socket, "open");
    client.send({ type: "hello", protocolVersion: 1, token, deviceId: DeviceId.parse(device) });
    await client.next();
    return client;
  }

  return {
    root,
    store,
    thread,
    runtime,
    connect,
    command,
    async close() {
      for (const client of clients) await client.close();
      await server.close();
      await runtime.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("deletion refuses an owned shell and succeeds after terminal close releases that work", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    client.send(
      TerminalRequest.parse({
        type: "terminal.request",
        requestId: "open",
        operation: { op: "open", threadId: f.thread.id },
      }),
    );
    const opened = await client.next();
    if (opened.type !== "terminal.result" || !opened.terminal) throw new Error("Expected terminal");
    const terminalId = opened.terminal.id;
    const stream = f.runtime.terminal(terminalId, f.thread.id).attach({ fromOffset: 0 });
    expect(
      await f.command(client, { type: "thread.delete", threadId: f.thread.id }, "blocked"),
    ).toMatchObject({ ok: false, error: "thread_busy" });
    expect(f.store.getThread(f.thread.id)?.deletedAt).toBeUndefined();
    client.send(
      TerminalRequest.parse({
        type: "terminal.request",
        requestId: "write",
        operation: {
          op: "write",
          threadId: f.thread.id,
          terminalId,
          data: "printf alive > alive.txt; exit 0\r",
        },
      }),
    );
    expect(await client.next()).toMatchObject({ type: "terminal.result", ok: true });
    try {
      for await (const event of stream)
        if (event.type === "exit") {
          expect(event.status.code).toBe(0);
          break;
        }
    } finally {
      stream.detach();
    }
    expect(await readFile(join(f.root, "alive.txt"), "utf8")).toBe("alive");
    client.send(
      TerminalRequest.parse({
        type: "terminal.request",
        requestId: "close",
        operation: { op: "close", threadId: f.thread.id, terminalId },
      }),
    );
    expect(await client.next()).toMatchObject({ type: "terminal.result", ok: true });
    expect(
      await f.command(client, { type: "thread.delete", threadId: f.thread.id }, "delete"),
    ).toMatchObject({ ok: true });
    expect(f.store.getThread(f.thread.id)?.deletedAt).toBe(1000);
    expect(f.runtime.listTerminals(f.thread.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a deleted thread's successful receipt survives reconnect without revealing it to another device", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    const payload = { type: "thread.delete" as const, threadId: f.thread.id };
    const receipt = await f.command(client, payload, "lost-reply");
    expect(receipt).toMatchObject({ ok: true, threadId: f.thread.id });
    const head = f.store.headSeq();
    await client.close();
    const reconnected = await f.connect();
    expect(await f.command(reconnected, payload, "lost-reply")).toEqual(receipt);
    expect(f.store.headSeq()).toBe(head);
    const stranger = await f.connect("phone");
    expect(await f.command(stranger, payload, "lost-reply", "phone")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(f.store.headSeq()).toBe(head);
  } finally {
    await f.close();
  }
});

test("another device cannot claim a receipt while the thread remains readable", async () => {
  const f = await fixture();
  try {
    const desktop = await f.connect(),
      phone = await f.connect("phone");
    const payload = {
      type: "thread.rename" as const,
      threadId: f.thread.id,
      title: "Private receipt",
    };
    expect(await command(desktop, payload, "device-owned")).toMatchObject({ ok: true });
    const head = f.store.headSeq();
    expect(await command(phone, payload, "device-owned", "phone")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(f.store.headSeq()).toBe(head);
  } finally {
    await f.close();
  }
});
