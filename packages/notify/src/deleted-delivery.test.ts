import { Event, ThreadId, WorkspaceId } from "@ace/protocol";
import { expect, it } from "vitest";
import type { DeliveryResult } from "./index.ts";
import { setup, writeLegacyQueue } from "./notify.test-helper.ts";

it.each([
  { outcome: "accepted", queue: "fresh" },
  { outcome: "retry", queue: "fresh" },
  { outcome: "accepted", queue: "upgraded" },
  { outcome: "retry", queue: "upgraded" },
] as const)(
  "a late $outcome for a deleted thread cannot discard or defer a live thread's notice on a $queue queue",
  async ({ outcome, queue }) => {
    const f = setup();
    const response = Promise.withResolvers<DeliveryResult>();
    const started = Promise.withResolvers<void>();
    try {
      if (queue === "upgraded") {
        await f.service.close();
        writeLegacyQueue(f.path, 3);
        await f.reopen();
      }
      f.transport.send = async (device, notification) => {
        f.deliveries.push({ device, notification });
        if (notification.threadId === f.threadId) {
          started.resolve();
          return response.promise;
        }
        return "accepted";
      };
      f.start();
      f.end();
      const draining = f.flush();
      await started.promise;
      f.append([{ type: "thread.client.updated", changes: { deletedAt: 6000 } }]);
      const liveThread = ThreadId.parse("live-thread");
      f.service.ingest([
        Event.parse({
          seq: f.service.cursor() + 1,
          id: "live-thread-created",
          threadId: liveThread,
          at: 6000,
          payload: {
            type: "thread.created",
            thread: {
              id: liveThread,
              workspaceId: WorkspaceId.parse("workspace"),
              provider: "codex",
              title: "Live thread",
              status: { state: "new" },
              createdAt: 6000,
              updatedAt: 6000,
            },
          },
        }),
      ]);
      f.service.notify({
        id: "live-notice",
        threadId: liveThread,
        title: "Live notice",
        status: "agent_says",
        backgroundCount: 0,
        actions: [],
      });
      response.resolve(outcome);
      await draining;
      await f.service.drain();
      expect(
        f.deliveries
          .filter(({ notification }) => notification.threadId === liveThread)
          .map(({ device, notification }) => ({ device: device.id, id: notification.id })),
      ).toEqual([
        { device: f.desktop, id: "live-notice" },
        { device: f.phone, id: "live-notice" },
      ]);
    } finally {
      response.resolve("accepted");
      await f.close();
    }
  },
);
