import { expect, test } from "vitest";
import { CommandId, DeviceId } from "@ace/protocol";
import type { PluginResponse } from "@ace/protocol/plugins";
import { fixture } from "./socket-test-support.ts";

const notifications = {
  async connectDevice() {
    throw new Error("Notification worker stopped");
  },
  async register() {},
  async preferences() {},
  async snooze() {},
  async updatePresence() {},
  async disconnect() {
    throw new Error("Presence cleanup failed");
  },
};

test("notification failure leaves clients connected and disconnect churn releases admission slots", async () => {
  const errors: unknown[] = [];
  const f = await fixture({ notifications, log: (error) => errors.push(error) });
  try {
    for (let i = 0; i < 260; i++) {
      const client = await f.connect();
      expect(await client.next()).toMatchObject({ type: "welcome" });
      client.send({ type: "presence.update", threadId: f.thread.id, inputAgeMs: 0 });
      client.send({ type: "ping" });
      expect(await client.next()).toEqual({ type: "pong" });
      await client.close();
    }
    expect(
      errors.some((error) => error instanceof Error && error.message === "Presence cleanup failed"),
    ).toBe(true);
    await expect(f.server.close()).resolves.toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a notification worker recovering without a reply cannot delay welcome or ordinary commands", async () => {
  const release = Promise.withResolvers<void>();
  const f = await fixture({
    notifications: {
      ...notifications,
      async connectDevice() {
        await release.promise;
      },
    },
  });
  try {
    const client = await f.connect();
    expect(await client.next()).toMatchObject({ type: "welcome" });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.send({
      type: "command",
      command: {
        id: CommandId.parse("archive"),
        deviceId: DeviceId.parse("device"),
        payload: { type: "thread.archive", threadId: f.thread.id },
      },
    });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      commandId: "archive",
      ok: true,
    });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("unrelated service requests cannot exhaust history admission", async () => {
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let pending = 0;
  const pluginClients: import("./socket-test-support.ts").Client[] = [];
  const f = await fixture({
    plugins: {
      async handle(): Promise<PluginResponse> {
        if (++pending === 8) held.resolve();
        await release.promise;
        return { type: "plugins.list", installs: [], reviews: [] };
      },
    },
    history: {
      async handle(message) {
        return {
          type: "history.list",
          requestId: "requestId" in message ? message.requestId : undefined,
          sessions: [],
          next: null,
        };
      },
    },
  });
  try {
    for (let i = 0; i < 8; i++) {
      const client = await f.connect();
      await client.next();
      pluginClients.push(client);
      client.socket.send(
        JSON.stringify({
          type: "pluginRequest",
          requestId: `plugin-${i}`,
          request: { type: "plugins.list" },
        }),
      );
    }
    await held.promise;
    const client = await f.connect();
    await client.next();
    client.send({ type: "history.list", requestId: "history", cwd: "/repo", limit: 10 });
    expect(await client.next()).toMatchObject({
      type: "history.list",
      requestId: "history",
      sessions: [],
    });
    // Close consumers before releasing plugin replies, whose wire union is separate.
    await client.close();
    await Promise.all(pluginClients.map((consumer) => consumer.close()));
    release.resolve();
    await f.close();
  } finally {
    release.resolve();
    await f.close();
  }
});

test("shutdown aborts in-flight history and finishes without waiting for its natural completion", async () => {
  const started = Promise.withResolvers<void>(),
    aborted = Promise.withResolvers<void>();
  const f = await fixture({
    history: {
      async handle(_message, signal) {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
        return { type: "history.list", sessions: [], next: null };
      },
    },
  });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "history.list", requestId: "pending", cwd: "/repo", limit: 10 });
    await started.promise;
    const closing = f.server.close();
    await aborted.promise;
    await expect(closing).resolves.toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a stuck socket task hits the injected shutdown deadline and identifies the drain", async () => {
  const started = Promise.withResolvers<void>(),
    armed = Promise.withResolvers<() => void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({
    preAuth: { helloMs: 10_000 },
    runtime: {
      delay(run, milliseconds) {
        if (milliseconds === 5000) {
          armed.resolve(run);
          return () => {};
        }
        const timer = setTimeout(run, milliseconds);
        return () => clearTimeout(timer);
      },
    },
    plugins: {
      async handle(): Promise<PluginResponse> {
        started.resolve();
        await release.promise;
        return { type: "plugins.list", installs: [], reviews: [] };
      },
    },
  });
  try {
    const client = await f.connect();
    await client.next();
    client.socket.send(
      JSON.stringify({
        type: "pluginRequest",
        requestId: "stuck",
        request: { type: "plugins.list" },
      }),
    );
    await started.promise;
    const closing = f.server.close();
    const rejected = expect(closing).rejects.toThrow("Socket tasks shutdown deadline exceeded");
    (await armed.promise)();
    await rejected;
  } finally {
    release.resolve();
    await f.close().catch(() => {});
  }
});
