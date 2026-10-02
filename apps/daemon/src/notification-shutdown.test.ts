import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startDaemon, readConfig } from "./index.ts";
import { Client, fixture } from "./socket-test-support.ts";

it("gracefully shuts down more than 64 unauthenticated connections", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-shutdown-"));
  const daemon = await startDaemon(
    readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
  );
  const clients: Client[] = [];
  try {
    await Promise.all(
      Array.from({ length: 128 }, async () => {
        const client = new Client(daemon.url);
        clients.push(client);
        await once(client.socket, "open");
      }),
    );
    await expect(daemon.close()).resolves.toBeUndefined();
  } finally {
    for (const client of clients) await client.close();
    await daemon.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

it("drains registered presence once per session without flooding notification RPC", async () => {
  const active = new Set<string>();
  const errors: unknown[] = [];
  let inFlight = false;
  const notifications = {
    async connectDevice() {},
    async register() {},
    async preferences() {},
    async snooze() {},
    async updatePresence(session: string) {
      active.add(session);
    },
    async disconnect(session: string) {
      if (inFlight) throw new Error("Notification boundary overloaded");
      if (!active.has(session)) throw new Error("No registered presence");
      inFlight = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      active.delete(session);
      inFlight = false;
    },
  };
  const f = await fixture({ notifications, log: (error) => errors.push(error) });
  try {
    // Unauthenticated sockets never registered a presence session.
    await Promise.all(Array.from({ length: 8 }, () => f.open()));
    for (let i = 0; i < 80; i++) {
      const client = await f.connect();
      await client.next();
      client.send({ type: "presence.update", threadId: f.thread.id, inputAgeMs: 0 });
      client.send({ type: "ping" });
      expect(await client.next()).toEqual({ type: "pong" });
    }
    expect(active.size).toBe(80);
    await f.server.close();
    expect(active.size).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);
