import { afterEach, expect, test } from "vitest";
import { Command, CommandId, type ThreadId } from "@ace/protocol";
import type { ScriptedStep } from "@ace/adapter-testkit";
import {
  cleanupRecovery,
  crashCopy,
  fixture,
  replaceProvider,
  sends,
  text,
  type RecoveryHarness,
} from "./recovery-test-support.ts";
import { end, scriptFrames, start, until } from "./test-support.ts";

afterEach(cleanupRecovery);

/**
 * A thread whose first message failed to start, held as not sent, with two more messages
 * waiting behind it. The provider then works again, answering with `steps`.
 */
async function heldBehindFailedSend(
  steps: (frames: ReturnType<typeof scriptFrames>) => ScriptedStep[],
) {
  const frames = scriptFrames();
  const h = await fixture([], frames);
  h.registry.register(
    {
      ...h.adapter,
      async openSession() {
        throw new Error("Cannot open directory");
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const id = await h.create();
  for (const words of ["second", "third"])
    expect(
      h.command({ type: "thread.send", threadId: id, input: text(words) }, "device", words).ok,
    ).toBe(true);
  await h.engine.flush();
  const held = h.engine.queue(id);
  expect(held).toMatchObject({ paused: true, reason: "not_sent" });
  expect(held.messages.map((message) => message.input)).toEqual([
    text("first"),
    text("second"),
    text("third"),
  ]);
  const failed = held.messages[0];
  if (!failed) throw new Error("Missing the failed message");
  const provider = replaceProvider(h, frames, steps(frames));
  return { h, id, failed: failed.id, provider };
}

const completes = (frames: ReturnType<typeof scriptFrames>, count: number): ScriptedStep[] =>
  Array.from({ length: count }, () => ({ on: "send", frames: [frames.frame(start, end)] }));

const target = (h: RecoveryHarness, id: ThreadId) => ({
  threadId: id,
  expectedRevision: h.engine.queue(id).revision,
});

test("removing the failed message releases the hold and the messages behind it go in order", async () => {
  const { h, id, failed, provider } = await heldBehindFailedSend((frames) => completes(frames, 2));
  expect(h.command({ type: "queue.remove", ...target(h, id), messageId: failed }).ok).toBe(true);
  // Released at once: nothing behind it reads as not sent while it waits its turn.
  expect(h.engine.queue(id)).toMatchObject({ paused: false, reason: null });
  await h.engine.flush();
  expect(sends(provider).map((command) => command.input)).toEqual([text("second"), text("third")]);
  expect(h.engine.queue(id)).toMatchObject({ paused: false, reason: null, messages: [] });
  expect(h.store.snapshotThread(id).items["input:second"]).toBeDefined();
});

test("editing the failed message releases the hold and sends the new words first", async () => {
  const { h, id, failed, provider } = await heldBehindFailedSend((frames) => completes(frames, 3));
  expect(
    h.command({
      type: "queue.edit",
      ...target(h, id),
      messageId: failed,
      input: text("first, fixed"),
    }).ok,
  ).toBe(true);
  expect(h.engine.queue(id)).toMatchObject({ paused: false, reason: null });
  await h.engine.flush();
  expect(sends(provider).map((command) => command.input)).toEqual([
    text("first, fixed"),
    text("second"),
    text("third"),
  ]);
  expect(h.engine.queue(id).messages).toEqual([]);
});

test("removing or editing a message behind the failed one keeps the hold", async () => {
  const { h, id, provider } = await heldBehindFailedSend((frames) => completes(frames, 1));
  expect(
    h.command({ type: "queue.remove", ...target(h, id), messageId: CommandId.parse("third") }).ok,
  ).toBe(true);
  expect(
    h.command({
      type: "queue.edit",
      ...target(h, id),
      messageId: CommandId.parse("second"),
      input: text("second, changed"),
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(sends(provider)).toEqual([]);
  const queue = h.engine.queue(id);
  expect(queue).toMatchObject({ paused: true, reason: "not_sent" });
  expect(queue.messages.map((message) => message.input)).toEqual([
    text("first"),
    text("second, changed"),
  ]);
});

test("an edit the daemon refuses keeps the hold and the failed message's words", async () => {
  const { h, id, failed, provider } = await heldBehindFailedSend((frames) => completes(frames, 3));
  const stale = h.engine.queue(id).revision - 1;
  expect(
    h.command({
      type: "queue.edit",
      threadId: id,
      expectedRevision: stale,
      messageId: failed,
      input: text("too late"),
    }).error,
  ).toBe("queue_conflict");
  await h.engine.flush();
  expect(sends(provider)).toEqual([]);
  expect(h.engine.queue(id)).toMatchObject({
    paused: true,
    reason: "not_sent",
    messages: [{ id: failed, input: text("first") }, {}, {}],
  });
});

test("two devices removing the failed message at once release it once and send each message once", async () => {
  const { h, id, failed, provider } = await heldBehindFailedSend((frames) => completes(frames, 2));
  const phone = await h.connect("phone");
  const desktop = await h.connect("desktop");
  const revision = h.engine.queue(id).revision;
  const removal = (deviceId: string) =>
    Command.parse({
      id: `remove-${deviceId}`,
      deviceId,
      payload: {
        type: "queue.remove",
        threadId: id,
        expectedRevision: revision,
        messageId: failed,
      },
    });
  const fromPhone = removal("phone");
  const fromDesktop = removal("desktop");
  phone.send({ type: "command", command: fromPhone });
  desktop.send({ type: "command", command: fromDesktop });
  const results = await Promise.all([
    until(phone, (m) => m.type === "commandResult" && m.commandId === fromPhone.id),
    until(desktop, (m) => m.type === "commandResult" && m.commandId === fromDesktop.id),
  ]);
  const outcomes = results.map((m) => (m.type === "commandResult" ? m : undefined));
  expect(outcomes.filter((result) => result?.ok)).toHaveLength(1);
  expect(outcomes.filter((result) => result?.error === "queue_conflict")).toHaveLength(1);
  await h.engine.flush();
  expect(sends(provider).map((command) => command.input)).toEqual([text("second"), text("third")]);
  expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
});

test("the thread keeps working, never idle, while messages behind a released hold remain", async () => {
  // The second message's turn stays open, so the third still waits behind it.
  const { h, id, failed } = await heldBehindFailedSend((frames) => [
    { on: "send", frames: [frames.frame(start)] },
  ]);
  expect(h.command({ type: "queue.remove", ...target(h, id), messageId: failed }).ok).toBe(true);
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({
    paused: false,
    reason: null,
    messages: [{ input: text("third"), state: "queued" }],
  });
  expect(h.store.snapshotThread(id).thread.status.state).toBe("working");
});

test("a restart after the failed message was removed never brings it back", async () => {
  const { h, id, failed } = await heldBehindFailedSend((frames) => [
    { on: "send", frames: [frames.frame(start)] },
  ]);
  expect(h.command({ type: "queue.remove", ...target(h, id), messageId: failed }).ok).toBe(true);
  await h.engine.flush();
  const recovered = await crashCopy(h);
  const queue = recovered.engine.queue(id);
  expect(queue.messages.map((message) => message.input)).toEqual([text("third")]);
  expect(recovered.store.snapshotThread(id).items[`input:${failed}`]).toBeUndefined();
});
