import { afterEach, expect, test } from "vitest";
import { Command, CommandId } from "@ace/protocol";
import { fixture, cleanupRecovery, sends } from "./recovery-test-support.ts";
import { scriptFrames, start, end, until } from "./test-support.ts";

afterEach(cleanupRecovery);

test("authenticated queue resend replaces uncertain input once and refuses stale recovery", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [{ on: "send" }, { on: "send", frames: [frames.frame(start, end)] }],
    frames,
  );
  const original = h.registry.get("codex").adapter;
  let attempts = 0;
  h.registry.register(
    {
      ...original,
      async openSession(ctx) {
        const session = await original.openSession(ctx);
        return {
          ...session,
          async send(input, mode, commandId) {
            await session.send(input, mode, commandId);
            if (++attempts === 1) throw new Error("Lost reply");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const id = await h.create();
  const message = h.engine.queue(id).messages[0];
  if (!message) throw new Error("Missing uncertain input");
  const client = await h.connect("device");
  const send = async (command: Command) => {
    client.send({ type: "command", command });
    return until(
      client,
      (response) => response.type === "commandResult" && response.commandId === command.id,
    );
  };
  const recovery = Command.parse({
    id: "wire-resend",
    deviceId: "device",
    payload: {
      type: "queue.resend",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      messageId: CommandId.parse(message.id),
    },
  });
  expect(
    await send(
      Command.parse({
        ...recovery,
        id: "stale-resend",
        payload: { ...recovery.payload, expectedRevision: 0 },
      }),
    ),
  ).toMatchObject({ ok: false, error: "queue_conflict" });
  expect(await send(recovery)).toMatchObject({ ok: true });
  await h.engine.flush();
  expect(await send(recovery)).toMatchObject({ ok: true });
  await h.engine.flush();
  expect(sends(h.adapter)).toHaveLength(2);
  expect(h.engine.queue(id).messages).toEqual([]);
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(h.store.snapshotThread(id).items["input:wire-resend"]).toMatchObject({
    type: "message",
    parts: message.input,
  });
});
