import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceId, Event, type Notification } from "@ace/protocol";
import { expect, it } from "vitest";
import { NotificationWorker } from "./index.ts";

it("worker messages omit unused giant identifiers and raw provider data while replay keeps progressing", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-ipc-"));
  const frames: string[] = [];
  const deliveries: Notification[] = [];
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    spawn(entry, options) {
      const owned = new Worker(entry, options);
      const send = owned.postMessage.bind(owned);
      owned.postMessage = (input: unknown, transfers: Parameters<Worker["postMessage"]>[1]) => {
        frames.push(JSON.stringify(input));
        send(input, transfers);
      };
      return owned;
    },
    transport: {
      async send(_device, notification) {
        deliveries.push(notification);
        return "accepted";
      },
    },
  });
  const now = Date.now();
  try {
    await worker.register(DeviceId.parse("device"), { channel: "websocket", platform: "desktop" });
    await worker.ingest([
      Event.parse({
        seq: 1,
        id: "e1",
        threadId: "t",
        at: now,
        payload: {
          type: "thread.created",
          thread: {
            id: "t",
            workspaceId: "w".repeat(8 * 1024 * 1024),
            rootAgentId: "a".repeat(8 * 1024 * 1024),
            provider: "codex",
            title: "Safe",
            status: { state: "new" },
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
    ]);
    await worker.ingest([
      Event.parse({
        seq: 2,
        id: "e2",
        threadId: "t",
        at: now,
        payload: {
          type: "interaction.opened",
          interaction: {
            id: "i",
            threadId: "t",
            agentId: "a",
            state: "pending",
            blocking: true,
            createdAt: now,
            request: { kind: "question", questions: [] },
            raw: [{ type: "private", data: "IPC_SECRET" }],
          },
        },
      }),
      Event.parse({
        seq: 3,
        id: "e3",
        threadId: "t",
        at: now,
        payload: { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
      }),
    ]);
    await worker.drain();
    expect(await worker.cursor()).toBe(3);
    expect(deliveries[0]?.interactionId).toBe("i");
    expect(Math.max(...frames.map((frame) => Buffer.byteLength(frame)))).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(frames.some((frame) => frame.includes("IPC_SECRET"))).toBe(false);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("maximal escaped metadata pages and oversized routing ids never poison worker replay", async () => {
  const worker = new NotificationWorker({
    path: ":memory:",
    windowMs: 0,
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  const at = Date.now();
  let seq = 0;
  const threadId = "t" + "\u0000".repeat(199);
  try {
    await worker.ingest([
      Event.parse({
        seq: ++seq,
        id: "ignored".repeat(100_000),
        threadId,
        at,
        payload: {
          type: "thread.created",
          thread: {
            id: threadId,
            workspaceId: "w",
            provider: "codex",
            title: "\u0000".repeat(200),
            status: { state: "new" },
            createdAt: at,
            updatedAt: at,
          },
        },
      }),
    ]);
    const events: Event[] = [];
    for (let i = 0; i < 256; i++)
      events.push(
        Event.parse({
          seq: ++seq,
          id: `e${seq}`,
          threadId,
          at,
          payload: {
            type: "interaction.opened",
            interaction: {
              id: `${i}` + "\u0000".repeat(197),
              agentId: "\u0000".repeat(200),
              threadId,
              state: "pending",
              blocking: true,
              createdAt: at,
              request: {
                kind: "approval",
                title: "private",
                options: [
                  { kind: "allow_once", id: "\u0000".repeat(200), label: "private" },
                  { kind: "deny", id: "\u0001".repeat(200), label: "private" },
                ],
              },
              raw: [],
            },
          },
        }),
      );
    await worker.ingest(events);
    await worker.ingest([
      Event.parse({
        seq: ++seq,
        id: `e${seq}`,
        threadId: "oversized".repeat(100_000),
        at,
        payload: { type: "thread.updated", status: { state: "done" } },
      }),
    ]);
    expect(await worker.cursor()).toBe(258);
  } finally {
    await worker.close();
  }
});
