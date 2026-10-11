import { createDevThread, type CommandHandler } from "@ace/daemon";
import { AgentId, Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { setup, ready, when, barrier, memoryStorage } from "./test-support.ts";

for (const admission of ["snapshot", "input.admitted"] as const) {
  test(`${admission} before eight delayed receipts releases the send window on a real socket`, async () => {
    const effects: string[] = [];
    const handler: CommandHandler = {
      handle(command) {
        effects.push(command.id);
        return { commandId: command.id, ok: true };
      },
    };
    const h = await setup(handler);
    try {
      const other = createDevThread(h.daemon.store, h.workspaceId);
      for (let i = 0; i < 200; i++)
        h.daemon.store.appendEvents(other.id, [
          {
            type: "item.created",
            item: Item.parse({
              type: "message",
              id: `large-${i}`,
              agentId: AgentId.parse("root"),
              createdAt: i,
              complete: true,
              role: "assistant",
              parts: [{ type: "text", text: "x".repeat(1024) }],
            }),
          },
        ]);
      const storage = memoryStorage();
      await storage.save(
        JSON.stringify(
          Array.from({ length: 9 }, (_, i) => ({
            command: {
              id: `send-${i}`,
              deviceId: "test-device",
              payload: {
                type: "thread.send",
                threadId: h.thread.id,
                input: [{ type: "text", text: `input ${i}` }],
              },
            },
            state: "pending",
          })),
        ),
      );
      const inputs = Array.from({ length: 8 }, (_, i) => ({
        type: "item.created" as const,
        item: Item.parse({
          type: "message",
          id: `input:send-${i}`,
          nativeId: `native-${i}`,
          agentId: AgentId.parse("root"),
          createdAt: i,
          complete: true,
          role: "user",
          parts: [{ type: "text", text: `input ${i}` }],
        }),
      }));
      if (admission === "snapshot") h.daemon.store.appendEvents(h.thread.id, inputs);
      const { client, faults } = h.make({ storage });
      const main = client.thread(h.thread.id);
      const second = client.thread(other.id);
      const receipts: (() => void)[] = [];
      faults.incoming = (message, text, deliver) => {
        if (message.type === "commandResult" && message.commandId !== "send-8")
          receipts.push(() => deliver(text));
        else deliver(text);
      };
      await ready(client);
      await barrier(client, h.thread.id);
      if (admission === "input.admitted") {
        expect(effects).toHaveLength(8);
        h.daemon.store.appendEvents(
          h.thread.id,
          Array.from({ length: 8 }, (_, i) => ({
            type: "input.admitted" as const,
            agentId: AgentId.parse("root"),
            nativeInputId: `native-${i}`,
            commandId: `send-${i}`,
          })),
        );
      }
      await when(client.intent("send-7"), (intent) => intent?.acknowledged === true);
      // The ninth command must reach the daemon while all eight earlier receipts are held.
      await when(client.intent("send-8"), (intent) => intent?.state === "acked");
      expect(effects).toEqual(Array.from({ length: 9 }, (_, i) => `send-${i}`));
      for (const receipt of receipts) receipt();
      await barrier(client, h.thread.id);
      h.daemon.store.appendEvents(h.thread.id, [
        {
          type: "input.admitted",
          agentId: AgentId.parse("root"),
          nativeInputId: "native-0",
          commandId: "send-0",
        },
      ]);
      for (const receipt of receipts) receipt();
      await barrier(client, h.thread.id);
      expect(effects.filter((id) => id === "send-8")).toHaveLength(1);
      main.release();
      second.release();
    } finally {
      await h.cleanup();
    }
  });
}

test("a failed admission save retains pending work and never opens a send slot before recovery", async () => {
  const effects: string[] = [];
  const h = await setup({
    handle(command) {
      effects.push(command.id);
      return { commandId: command.id, ok: true };
    },
  });
  try {
    const disk = memoryStorage();
    await disk.save(
      JSON.stringify(
        Array.from({ length: 9 }, (_, i) => ({
          command: {
            id: `send-${i}`,
            deviceId: "test-device",
            payload: {
              type: "thread.send",
              threadId: h.thread.id,
              input: [{ type: "text", text: `input ${i}` }],
            },
          },
          state: "pending",
        })),
      ),
    );
    let fail = false;
    const storage = {
      load: () => disk.load(),
      save: (value: string) => (fail ? Promise.reject(new Error("disk full")) : disk.save(value)),
    };
    const first = h.make({ storage });
    first.faults.incoming = (message, text, deliver) => {
      if (message.type !== "commandResult") deliver(text);
    };
    const lease = first.client.thread(h.thread.id);
    await ready(first.client);
    await barrier(first.client, h.thread.id);
    expect(effects).toHaveLength(8);
    fail = true;
    h.daemon.store.appendEvents(h.thread.id, [
      {
        type: "input.admitted",
        agentId: AgentId.parse("root"),
        nativeInputId: "native-0",
        commandId: "send-0",
      },
    ]);
    await when(first.client.connectionState(), (state) => state === "fatal");
    expect(first.client.intent("send-0").getSnapshot()?.state).toBe("pending");
    expect(effects).not.toContain("send-8");
    lease.release();
    await first.client.close();
    fail = false;
    const recovered = h.make({ storage }).client;
    await ready(recovered);
    await when(recovered.intent("send-8"), (intent) => intent?.state === "acked");
    expect(effects).toEqual(Array.from({ length: 9 }, (_, i) => `send-${i}`));
  } finally {
    await h.cleanup();
  }
});
