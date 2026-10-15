import { expect, test } from "vitest";
import { Command, CommandId, type ThreadId } from "@ace/protocol";
import { harness, scriptFrames, start, end, until } from "./test-support.ts";

const send = (id: string, threadId: ThreadId, text: string) => ({
  type: "command" as const,
  command: Command.parse({
    id,
    deviceId: "device",
    payload: { type: "thread.send", threadId, input: [{ type: "text", text }], delivery: "queue" },
  }),
});

test("a ping is answered while a thread.send waits on provider activation", async () => {
  let activation: PromiseWithResolvers<void> | undefined;
  const frames = scriptFrames();
  const turn = () => ({ on: "send" as const, frames: [frames.frame(start, end)] });
  const h = await harness([turn(), turn(), turn()], frames, {
    waitForProvider: () => activation?.promise ?? Promise.resolve(),
  });
  try {
    const threadId = await h.create();
    const client = await h.connect("device");
    activation = Promise.withResolvers<void>();
    client.send(send("send-first", threadId, "first follow-up"));
    client.send(send("send-second", threadId, "second follow-up"));
    client.send({ type: "ping" });
    // The provider is still activating: liveness must not wait behind the sends.
    expect(await client.next()).toEqual({ type: "pong" });
    activation.resolve();
    const results: string[] = [];
    while (results.length < 2) {
      const message = await until(client, (entry) => entry.type === "commandResult");
      if (message.type === "commandResult") {
        expect(message).toMatchObject({ ok: true });
        results.push(message.commandId);
      }
    }
    // Sends to one thread keep their order once the provider is ready.
    expect(results).toEqual(["send-first", "send-second"]);
  } finally {
    activation?.resolve();
    await h.close();
  }
});

test("command status tells a waiting client what the daemon is running, settled or never saw", async () => {
  let activation: PromiseWithResolvers<void> | undefined;
  const frames = scriptFrames();
  const turn = () => ({ on: "send" as const, frames: [frames.frame(start, end)] });
  const h = await harness([turn(), turn()], frames, {
    waitForProvider: () => activation?.promise ?? Promise.resolve(),
  });
  try {
    const threadId = await h.create();
    const client = await h.connect("device");
    activation = Promise.withResolvers<void>();
    client.send(send("send-waiting", threadId, "waits for the provider"));
    client.send({
      type: "command.status",
      requestId: "while-activating",
      commandIds: [CommandId.parse("send-waiting"), CommandId.parse("never-sent")],
    });
    expect(await until(client, (entry) => entry.type === "command.status")).toEqual({
      type: "command.status",
      requestId: "while-activating",
      commands: [
        { commandId: "send-waiting", state: "running" },
        { commandId: "never-sent", state: "unknown" },
      ],
    });
    activation.resolve();
    expect(await until(client, (entry) => entry.type === "commandResult")).toMatchObject({
      commandId: "send-waiting",
      ok: true,
    });
    client.send({
      type: "command.status",
      requestId: "after",
      commandIds: [CommandId.parse("send-waiting")],
    });
    // A settled command's receipt is sent again ahead of the status reply.
    expect(await client.next()).toMatchObject({ type: "commandResult", commandId: "send-waiting" });
    expect(await client.next()).toMatchObject({
      type: "command.status",
      commands: [{ commandId: "send-waiting", state: "settled" }],
    });
  } finally {
    activation?.resolve();
    await h.close();
  }
});
