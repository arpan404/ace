import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { Command, DeviceId, Thread, type ProviderKind } from "@ace/protocol";
import { Store } from "./store.ts";
import { startServer } from "./server.ts";
import { stubHandler } from "./commands.ts";
import { Client, token } from "./socket-test-support.ts";
import { openDaemonHistory } from "./history.ts";

test.each<ProviderKind>(["claude", "codex", "opencode", "cursor", "pi", "acp"])(
  "%s deletion survives database reopen, history scanning and reconnect",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "ace-deleted-recovery-"));
    const path = join(root, "events.sqlite");
    const home = join(root, "claude");
    await mkdir(join(home, "projects/p"), { recursive: true });
    await writeFile(
      join(home, "projects/p/native.jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: "native",
        cwd: root,
        message: { role: "user", content: "Existing provider session" },
      }) + "\n",
    );
    let store = new Store(path, undefined, { now: () => 1000 });
    const workspaceId = store.createWorkspace(root, "Project");
    const thread = Thread.parse({
      id: "deleted",
      workspaceId,
      provider,
      title: "Deleted",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    const open = () =>
      startServer({
        store,
        port: 0,
        token,
        hostId: "host",
        now: () => 1000,
        handler: stubHandler(),
      });
    let server = await open();
    const clients: Client[] = [];
    const connect = async () => {
      const client = new Client(server.url);
      clients.push(client);
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        token,
        deviceId: DeviceId.parse("desktop"),
      });
      await client.next();
      return client;
    };
    const command = Command.parse({
      id: "delete",
      deviceId: "desktop",
      payload: { type: "thread.delete", threadId: thread.id },
    });
    try {
      const client = await connect();
      client.send({ type: "command", command });
      const receipt = await client.next();
      expect(receipt).toMatchObject({ ok: true });
      await client.close();
      await server.close();
      store.close();
      store = new Store(path);
      server = await open();
      const history = await openDaemonHistory(root, store, {
        instances: [{ id: "account", provider: "claude", homeDir: home }],
      });
      try {
        await history.startScan();
        expect(history.scanStatus().state).toBe("ready");
        expect(store.getThread(thread.id)?.deletedAt).toBe(1000);
        const reconnected = await connect();
        reconnected.send({ type: "command", command });
        expect(await reconnected.next()).toEqual(receipt);
        reconnected.send({ type: "subscribe", subscriptionId: "list", scope: { kind: "threads" } });
        expect(await reconnected.next()).toMatchObject({ type: "snapshot", view: { threads: {} } });
      } finally {
        await history.close();
      }
    } finally {
      for (const client of clients) await client.close();
      await server.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
