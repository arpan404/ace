import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readConfig, startDaemon } from "@ace/daemon";
import { DeviceId } from "@ace/protocol";
import { Client, webSocketTransport } from "./index.ts";
import { ManualScheduler, memoryStorage, ready, when } from "./test-support.ts";

test("the client retries after the daemon closes its socket with 1009", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-client-1009-"));
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: join(root, "ace"), ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    handler: { handle: (command) => ({ commandId: command.id, ok: false, error: "unused" }) },
  });
  const sockets: WebSocket[] = [];
  const scheduler = new ManualScheduler();
  let seq = 0;
  const client = new Client({
    transport: () =>
      webSocketTransport(() => {
        const socket = new WebSocket(daemon.url);
        sockets.push(socket);
        return socket;
      }),
    scheduler,
    storage: memoryStorage(),
    credential: async () => readFile(daemon.tokenPath, "utf8"),
    id: () => `retry-${++seq}`,
    random: () => 0.5,
    deviceId: DeviceId.parse("retry-client"),
  });
  try {
    await ready(client);
    // A frame above the daemon's 1 MiB message cap: the daemon closes the socket with 1009.
    sockets[0]?.send(JSON.stringify({ type: "ping", padding: "x".repeat(1024 * 1024 + 1) }));
    await when(client.connectionState(), (state) => state === "reconnecting");
    expect(client.connectionInfo().getSnapshot().lastClose?.code).toBe(1009);
    expect(client.state).not.toBe("fatal");
    scheduler.advance(30_000);
    await when(client.connectionState(), (state) => state === "ready");
    expect(sockets).toHaveLength(2);
    expect(client.error).toBeUndefined();
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
