import { afterEach, expect, test } from "vitest";
import { Command, CommandId } from "@ace/protocol";
import { fixture, cleanupRecovery } from "./recovery-test-support.ts";
import { harness, scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test("an input queued behind a turn is waiting, then delivered into the run that took it", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send" }, { on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    const sent = h.command(
      {
        type: "thread.send",
        threadId: id,
        delivery: "queue",
        input: [{ type: "text", text: "q" }],
      },
      "device",
      "queued-input",
    );
    expect(sent.ok).toBe(true);
    const queued = CommandId.parse("queued-input");
    expect(h.engine.inputFate(id, queued)).toEqual({ state: "waiting" });
    await h.contexts.at(-1)?.onFrame(frames.frame(start, end));
    await h.engine.flush();
    const fate = h.engine.inputFate(id, queued);
    expect(fate.state).toBe("delivered");
    const run = h.store.snapshotThread(id).items["input:queued-input"];
    expect(run?.runId).toBeDefined();
    expect(fate).toEqual({ state: "delivered", runId: run?.runId });
  } finally {
    await h.close();
  }
});

test("an input the person takes out of the queue is removed", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send" }], frames);
  try {
    const id = await h.create();
    h.command(
      {
        type: "thread.send",
        threadId: id,
        delivery: "queue",
        input: [{ type: "text", text: "q" }],
      },
      "device",
      "taken-out",
    );
    const removed = h.command({
      type: "queue.remove",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      messageId: CommandId.parse("taken-out"),
    });
    expect(removed.ok).toBe(true);
    expect(h.engine.inputFate(id, CommandId.parse("taken-out"))).toEqual({ state: "removed" });
  } finally {
    await h.close();
  }
});

test("an uncertain input the person sends again is replaced by the resend's command", async () => {
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
  const first = CommandId.parse(message.id);
  expect(h.engine.inputFate(id, first)).toEqual({ state: "uncertain" });
  const resend = Command.parse({
    id: "resent-input",
    deviceId: "device",
    payload: {
      type: "queue.resend",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      messageId: first,
    },
  });
  expect(
    h.store.recordCommand(resend.id, resend.deviceId, () =>
      h.engine.handler.handle(resend, h.store),
    ).ok,
  ).toBe(true);
  expect(h.engine.inputFate(id, first)).toEqual({ state: "replaced", by: "resent-input" });
  await h.engine.flush();
  expect(h.engine.inputFate(id, CommandId.parse("resent-input")).state).toBe("delivered");
});
