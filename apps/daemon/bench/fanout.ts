// Non-gating. Daemon CPU per committed event with 1, 3 and 6 subscribers on one thread.
// Real SQLite, real server and real WebSockets; clients run in a separate process so their
// parsing is not charged to the daemon. Never starts a provider CLI.
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Thread, ItemId } from "@ace/protocol";
import { Store, stubHandler } from "../src/index.ts";
import { startServer } from "../src/server.ts";

const events = Number(process.env.FANOUT_EVENTS ?? 3000);
const rounds = Number(process.env.FANOUT_ROUNDS ?? 3);
const counts = [1, 3, 6];
if (process.argv[2] === "client") {
  const [url, token, count] = process.argv.slice(3);
  let received = 0;
  const sockets = Array.from({ length: Number(count) }, (_, index) => {
    const socket = new WebSocket(String(url));
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: `fan-${index}`, token }),
      ),
    );
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data));
      if (frame.type === "welcome")
        socket.send(
          JSON.stringify({
            type: "subscribe",
            subscriptionId: `s${index}`,
            scope: { kind: "thread", threadId: "thread" },
          }),
        );
      else if (frame.type === "snapshot") process.send?.({ ready: index });
      else if (frame.type === "events") {
        received += frame.events.length;
        process.send?.({ received });
      }
    });
    return socket;
  });
  process.on("message", () => {
    for (const socket of sockets) socket.close();
    process.exit(0);
  });
} else {
  const home = mkdtempSync(join(tmpdir(), "ace-fanout-bench-"));
  const store = new Store(join(home, "events.sqlite"));
  const token = "a".repeat(64);
  const server = await startServer({
    port: 0,
    token,
    hostId: "bench",
    store,
    handler: stubHandler(),
  });
  const workspaceId = store.createWorkspace(home, "Bench");
  store.appendEvents("thread" as never, [
    {
      type: "thread.created",
      thread: Thread.parse({
        id: "thread",
        workspaceId,
        provider: "codex",
        title: "Bench",
        rootAgentId: "root",
        status: { state: "new" },
        createdAt: 0,
        updatedAt: 0,
      }),
    },
  ]);
  const results: Record<number, number[]> = {};
  try {
    for (let round = 0; round < rounds; round++)
      for (const count of counts) {
        const item = ItemId.parse(`answer-${round}-${count}`);
        store.appendEvents(
          "thread" as never,
          [
            {
              type: "item.created",
              item: {
                type: "message",
                id: item,
                agentId: "root",
                role: "assistant",
                createdAt: 0,
                complete: false,
                raw: [],
                parts: [{ type: "text", text: "" }],
              },
            },
          ] as never,
        );
        const client = fork(
          new URL(import.meta.url),
          ["client", server.url, token, String(count)],
          {
            execArgv: [],
          },
        );
        let ready = 0;
        let received = 0;
        const target = events * count;
        const finished = Promise.withResolvers<void>();
        const allReady = Promise.withResolvers<void>();
        client.on("message", (message: { ready?: number; received?: number }) => {
          if (message.ready !== undefined && ++ready === count) allReady.resolve();
          if (message.received !== undefined) {
            received = message.received;
            if (received >= target) finished.resolve();
          }
        });
        await allReady.promise;
        const before = process.cpuUsage();
        for (let index = 0; index < events; index++) {
          store.appendEvents(
            "thread" as never,
            [
              {
                type: "item.delta",
                agentId: "root",
                itemId: item,
                field: "text",
                append: `token ${index} `.repeat(4),
              },
            ] as never,
          );
          if (index % 50 === 49) await new Promise((resolve) => setImmediate(resolve));
        }
        await finished.promise;
        const used = process.cpuUsage(before);
        const perEvent = (used.user + used.system) / events;
        (results[count] ??= []).push(perEvent);
        client.send("stop");
        await once(client, "exit");
      }
  } finally {
    await server.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
  const summary = Object.fromEntries(
    Object.entries(results).map(([count, values]) => {
      const sorted = values.toSorted((a, b) => a - b);
      return [
        count,
        {
          medianMicrosPerEvent: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
          runs: values.map(Math.round),
        },
      ];
    }),
  );
  console.log(
    JSON.stringify({ node: process.version, events, rounds, subscribers: summary }, null, 2),
  );
}
