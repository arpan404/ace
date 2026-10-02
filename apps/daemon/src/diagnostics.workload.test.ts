import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, DeviceId } from "@ace/protocol";
import { expect, it } from "vitest";
import { startDaemon, readConfig } from "./index.ts";
import { Client } from "./socket-test-support.ts";

it("daemon health reads current engine workload and preserves its own queue counters", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-diag-workload-"));
  let sessions = 4,
    pending = 2;
  const daemon = await startDaemon(
    readConfig({ ACE_HOME: root, ACE_PORT: "0" }),
    undefined,
    [],
    undefined,
    [],
    () => ({ activeSessions: sessions, queues: { engine: pending, "daemon.healthRequests": 999 } }),
  );
  const client = new Client(daemon.url);
  try {
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("workload-test"),
      token: await readFile(daemon.tokenPath, "utf8"),
    });
    await client.next();
    const head = daemon.store.headSeq();
    for (const expected of [
      { sessions: 4, pending: 2 },
      { sessions: 1, pending: 0 },
    ]) {
      sessions = expected.sessions;
      pending = expected.pending;
      client.send({
        type: "command",
        command: Command.parse({
          id: `health-${sessions}`,
          deviceId: "workload-test",
          payload: { type: "diagnostics.health" },
        }),
      });
      const response = await client.next();
      expect(response).toMatchObject({
        type: "commandResult",
        ok: true,
        health: {
          activeSessions: expected.sessions,
          queues: { engine: expected.pending, "daemon.healthRequests": 1 },
        },
      });
      expect(daemon.store.headSeq()).toBe(head);
    }
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
