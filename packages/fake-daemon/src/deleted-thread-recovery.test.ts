import { Client } from "@ace/client";
import { DeviceId, ThreadId, type ProviderKind } from "@ace/protocol";
import { expect, test, vi } from "vitest";
import { FakeDaemon, fakeTransport } from "./index.ts";

test.each<ProviderKind>(["claude", "codex", "opencode", "cursor", "pi", "acp"])(
  "%s deletion stays absent after fake client reconnect and receipt retry",
  async (provider) => {
    const daemon = new FakeDaemon({ clock: () => 1000 });
    const threadId = ThreadId.parse("deleted");
    daemon.createThread({ id: threadId, workspaceId: "project", provider, title: "Deleted" });
    let sequence = 0;
    const client = new Client({
      deviceId: DeviceId.parse("desktop"),
      transport: () => fakeTransport(daemon),
      credential: async () => daemon.token,
      storage: { load: async () => null, save: async () => {} },
      scheduler: {
        set(delay, callback) {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      random: () => 0,
      id: () => `id-${++sequence}`,
    });
    const lease = client.threads();
    try {
      await client.start();
      await vi.waitFor(() => expect(lease.store.thread(threadId)?.title).toBe("Deleted"));
      const payload = { type: "thread.delete" as const, threadId };
      const receipt = await client.command(payload, {}, "delete");
      expect(receipt.ok).toBe(true);
      await vi.waitFor(() => expect(lease.store.thread(threadId)).toBeUndefined());
      client.networkOnline(false);
      client.networkOnline(true);
      await vi.waitFor(() => expect(client.state).toBe("ready"));
      expect(await client.command(payload, {}, "delete")).toEqual(receipt);
      expect(lease.store.thread(threadId)).toBeUndefined();
      expect(daemon.snapshot({ kind: "thread", threadId })).toBeUndefined();
    } finally {
      lease.release();
      await client.close();
    }
  },
);
