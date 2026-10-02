import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { PluginResponse } from "@ace/protocol/plugins";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startDaemon, readConfig } from "./index.ts";
import { Client, fixture } from "./socket-test-support.ts";

it("finishes pending plugin persistence before reporting a presence shutdown failure", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let marker: string | undefined;
  let dispatched = false;
  let persisted = false;
  const f = await fixture({
    plugins: {
      async handle(): Promise<PluginResponse> {
        dispatched = true;
        started.resolve();
        try {
          await release.promise;
          if (!marker) throw new Error("Missing marker");
          await writeFile(marker, "Plugin persisted");
          persisted = true;
          return { type: "plugins.list", installs: [], reviews: [] };
        } finally {
          completed.resolve();
        }
      },
    },
    notifications: {
      async connectDevice() {},
      async register() {},
      async preferences() {},
      async snooze() {},
      async updatePresence() {},
      async disconnect() {
        throw new Error("Presence removal failed");
      },
    },
  });
  marker = join(f.home, "plugin-result");
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "presence.update", threadId: f.thread.id, inputAgeMs: 0 });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.socket.send(
      JSON.stringify({
        type: "pluginRequest",
        requestId: "pending",
        request: { type: "plugins.list" },
      }),
    );
    await started.promise;
    const disconnected = once(client.socket, "close");
    const shutdown = f.server.close().then(
      () => ({ persisted, error: undefined }),
      (error: unknown) => ({
        persisted,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    await disconnected;
    release.resolve();
    expect(await shutdown).toEqual({ persisted: true, error: "Presence removal failed" });
    expect(await readFile(marker, "utf8")).toBe("Plugin persisted");
  } finally {
    release.resolve();
    if (dispatched) await completed.promise;
    await f.close().catch(() => {});
    f.store.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it("gracefully shuts down more than 64 unauthenticated connections", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-shutdown-"));
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
  });
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
});

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
});

it("refuses connection churn until stalled presence removals are acknowledged", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const active = new Set<string>();
  let removed: (() => void) | undefined;
  const drained = new Promise<void>((resolve) => {
    removed = resolve;
  });
  const f = await fixture({
    notifications: {
      async connectDevice() {},
      async register() {},
      async preferences() {},
      async snooze() {},
      async updatePresence(session) {
        active.add(session);
      },
      async disconnect(session) {
        started?.();
        await gate;
        active.delete(session);
        if (!active.size) removed?.();
      },
    },
  });
  try {
    const clients = [];
    for (let i = 0; i < 256; i++) {
      const client = await f.connect();
      await client.next();
      client.send({ type: "presence.update", threadId: f.thread.id, inputAgeMs: 0 });
      client.send({ type: "ping" });
      expect(await client.next()).toEqual({ type: "pong" });
      clients.push(client);
    }
    await Promise.all(clients.map((client) => client.close()));
    await ready;
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(f.server.httpUrl, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      request.on("response", (reply) => {
        reply.resume();
        resolve(reply.statusCode ?? 0);
      });
      request.on("upgrade", (_reply, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(503);
    release?.();
    await drained;
    const recovered = await f.connect();
    expect(await recovered.next()).toMatchObject({ type: "welcome" });
    // Shutdown is an acknowledgement barrier for all queued removals.
    await expect(f.server.close()).resolves.toBeUndefined();
  } finally {
    release?.();
    await f.close();
  }
});

it("reports unacknowledged presence removal as a shutdown failure", async () => {
  const f = await fixture({
    notifications: {
      async connectDevice() {},
      async register() {},
      async preferences() {},
      async snooze() {},
      async updatePresence() {},
      async disconnect() {
        throw new Error("Removal unavailable");
      },
    },
  });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "presence.update", threadId: f.thread.id, inputAgeMs: 0 });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    await expect(f.server.close()).rejects.toThrow("Removal unavailable");
  } finally {
    await f.close().catch(() => {});
    f.store.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
