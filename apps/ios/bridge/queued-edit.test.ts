import {
  commands,
  connect,
  fixture,
  latest,
  open,
  pump,
  queueRefusals,
  refuseOnce,
  reset,
  sent,
  until,
} from "./thread-harness.ts";
import { afterEach, expect, test } from "vitest";
import { facts, fixtureImage } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId, type QueuePage } from "@ace/protocol";
import { tokensFromInput } from "@ace/ui-core";
import type { ClientCore } from "@ace/client";
import { followDismissed } from "./dismissed-sends.ts";
import { followInbox, inboxAction } from "./inbox.ts";
import { SendOps } from "./send-ops.ts";

afterEach(reset);

interface Queue {
  notSent: { id: string; text: string; attachments: number } | null;
}
const queue = () => latest("thread.queue") as Queue | undefined;
const words = (id: string) =>
  latest("words", id) as { ok: boolean; text: string | null; message: string } | undefined;
const clock = {
  now: () => Date.now(),
  set: (ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** The daemon's own queue for the thread, as another device would read it. */
async function daemonQueue(owner: ClientCore, id: string): Promise<QueuePage> {
  return (await owner.request({ type: "queue.get", threadId: ThreadId.parse(id) })).queue;
}

/** A held head that wasn't sent (with an uploaded image), two more messages behind it. */
async function heldThread(id: string, first: string) {
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
  fake.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  fake.seedServices({ attachmentImages: [{ threadId: id, name: fixtureImage.name }] });
  fake.holdQueue(id, "not_sent", { title: "Codex couldn't start.", code: "session_start_failed" });
  const files = { mentions: [], attachments: [{ sha256: fixtureImage.sha256 }] };
  const messages: [string, string, typeof files | undefined][] = [
    ["held-1", first, files],
    ["held-2", "Then write the tests", undefined],
    ["held-3", "Then open a pull request", undefined],
  ];
  for (const [command, text, context] of messages)
    expect(
      fake.command({
        id: CommandId.parse(command),
        deviceId: DeviceId.parse("seed"),
        payload: {
          type: "thread.send",
          threadId: ThreadId.parse(id),
          input: [{ type: "text", text }],
          delivery: "queue",
          ...(context ? { context } : {}),
        },
      }),
    ).toMatchObject({ ok: true });
  const owner = connect(fake);
  const thread = open(owner, id);
  const held = await until(() => queue()?.notSent ?? undefined, "the message that wasn't sent");
  return { owner, thread, held };
}

test("editing a held message changes its words where it waits, nothing removed", async () => {
  const { owner, thread, held } = await heldThread("edit-in-place", "Add retries to the handler");
  const before = await daemonQueue(owner, "edit-in-place");
  thread.handle({ type: "queueWords", messageId: held.id, requestId: "w1" });
  await until(() => words("w1"), "the full words");
  expect(words("w1")?.text).toBe("Add retries to the handler");
  thread.handle({
    type: "queue",
    messageId: held.id,
    change: { kind: "words", text: "Add retries with backoff to the handler" },
    requestId: "e1",
  });
  await until(() => latest("receipt", "e1"), "the daemon's answer");
  expect(latest("receipt", "e1")?.ok).toBe(true);
  const after = await daemonQueue(owner, "edit-in-place");
  // Same messages in the same places; only the words changed, the image still on it.
  expect(after.messages.map((message) => message.id)).toEqual(
    before.messages.map((message) => message.id),
  );
  const edited = after.messages[0];
  expect(edited && tokensFromInput(edited.input).text).toBe(
    "Add retries with backoff to the handler",
  );
  expect(edited?.context?.attachments).toEqual([{ sha256: fixtureImage.sha256 }]);
  expect(commands("queue.remove")).toEqual([]);
});

test("an edit the daemon refuses leaves the original queued as it was", async () => {
  const { owner, thread, held } = await heldThread("edit-refused", "Add retries to the handler");
  queueRefusals.edit = true;
  thread.handle({
    type: "queue",
    messageId: held.id,
    change: { kind: "words", text: "Something else entirely" },
    requestId: "e2",
  });
  await until(() => latest("receipt", "e2"), "the refusal");
  expect(latest("receipt", "e2")?.ok).toBe(false);
  const after = await daemonQueue(owner, "edit-refused");
  expect(after.messages.map((message) => tokensFromInput(message.input).text)).toEqual([
    "Add retries to the handler",
    "Then write the tests",
    "Then open a pull request",
  ]);
  expect(commands("queue.remove")).toEqual([]);
});

test("a message longer than the preview is read and edited in full", async () => {
  const long = `Refactor ${"the relay outbox ".repeat(700)}END`;
  const { owner, thread, held } = await heldThread("edit-long", long);
  expect(held.text.length).toBeLessThan(long.length);
  thread.handle({ type: "queueWords", messageId: held.id, requestId: "w2" });
  await until(() => words("w2"), "the full words");
  expect(words("w2")?.text).toBe(long);
  thread.handle({
    type: "queue",
    messageId: held.id,
    change: { kind: "words", text: `${long} Thanks.` },
    requestId: "e3",
  });
  await until(() => latest("receipt", "e3")?.ok, "the edit");
  const [edited] = (await daemonQueue(owner, "edit-long")).messages;
  expect(edited && tokensFromInput(edited.input).text).toBe(`${long} Thanks.`);
});

test("editing a failed send rewrites it in the outbox, and Retry sends the new words", async () => {
  const fake = fixture();
  fake.createThread({ id: "send-edit", workspaceId: "ace", title: "s", provider: "codex" });
  fake.apply("send-edit", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const owner = connect(fake);
  const inbox = followInbox(
    owner,
    "machine",
    pump,
    clock,
    undefined,
    undefined,
    undefined,
    followDismissed({ load: async () => "", save: async () => {} }),
  );
  const thread = open(owner, "send-edit");
  await until(() => latest("thread.controls"), "composer controls");
  const long = `${refuseOnce.text}${" and keep going".repeat(800)}`;
  refuseOnce.text = long;
  thread.handle({ type: "send", text: long, opposite: false, requestId: "first" });
  const id = await until(
    () =>
      owner
        .pendingSends()
        .getSnapshot()
        .find((send) => send.state === "failed")?.commandId,
    "the failed send",
  );
  inboxAction(owner, { kind: "sendWords", commandId: id }, "s1", pump, inbox);
  await until(() => words("s1"), "its full words");
  expect(words("s1")?.text).toBe(long);
  inboxAction(owner, { kind: "editSend", commandId: id, text: "Ship it today" }, "s2", pump, inbox);
  await until(() => words("s2"), "the saved edit");
  expect(words("s2")?.ok).toBe(true);
  const [part] = owner.pendingSend(id)?.payload.input ?? [];
  expect(part).toEqual({ type: "text", text: "Ship it today" });
  thread.handle({ type: "retrySend", id, requestId: "r1" });
  await until(() => latest("admission", "r1")?.ok, "the retry");
  expect(
    sent.some((text) => text.includes(`"id":"${id}:retry"`) && text.includes("Ship it today")),
  ).toBe(true);
  inbox();
});

test("an edit read before another device's save never overwrites it, and shows the newer words", async () => {
  const { owner, thread, held } = await heldThread("edit-raced", "Version A");
  thread.handle({ type: "queueWords", messageId: held.id, requestId: "w3" });
  await until(() => words("w3"), "the words as read");
  const read = latest("words", "w3") as { text: string; revision: number };
  expect(read.text).toBe("Version A");
  // Another device saves B, and the phone's queue follows it.
  const page = await daemonQueue(owner, "edit-raced");
  const [first] = page.messages;
  const other = await owner.command({
    type: "queue.edit",
    threadId: ThreadId.parse("edit-raced"),
    expectedRevision: page.revision,
    messageId: CommandId.parse(held.id),
    input: [{ type: "text", text: "Version B" }],
    ...(first?.context ? { context: first.context } : {}),
  });
  expect(other.ok).toBe(true);
  await until(() => queue()?.notSent?.text === "Version B", "the phone following B");
  // Save of the sheet's words, fenced to what they were read at: refused, B stays.
  thread.handle({
    type: "queue",
    messageId: held.id,
    change: { kind: "words", text: "Version A, edited", revision: read.revision },
    requestId: "e4",
  });
  await until(() => latest("receipt", "e4"), "the answer");
  expect(latest("receipt", "e4")?.ok).toBe(false);
  const [kept] = (await daemonQueue(owner, "edit-raced")).messages;
  expect(kept && tokensFromInput(kept.input).text).toBe("Version B");
  // Read again: the newer words and revision; saving over them now is deliberate.
  thread.handle({ type: "queueWords", messageId: held.id, requestId: "w4" });
  await until(() => words("w4"), "the newer words");
  const newer = latest("words", "w4") as { text: string; revision: number };
  expect(newer.text).toBe("Version B");
  thread.handle({
    type: "queue",
    messageId: held.id,
    change: { kind: "words", text: "Version A, edited", revision: newer.revision },
    requestId: "e5",
  });
  await until(() => latest("receipt", "e5")?.ok, "the deliberate save");
});

async function failedSendThread(id: string) {
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
  fake.apply(id, [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const owner = connect(fake);
  const ops = new SendOps();
  const inbox = followInbox(
    owner,
    "machine",
    pump,
    clock,
    undefined,
    undefined,
    undefined,
    followDismissed({ load: async () => "", save: async () => {} }),
    ops,
  );
  const thread = open(owner, id, undefined, ops);
  await until(() => latest("thread.controls"), "composer controls");
  thread.handle({ type: "send", text: refuseOnce.text, opposite: false, requestId: "first" });
  const sendId = await until(
    () =>
      owner
        .pendingSends()
        .getSnapshot()
        .find((send) => send.state === "failed")?.commandId,
    "the failed send",
  );
  return { owner, inbox, thread, sendId };
}
const retried = (id: string) =>
  sent.flatMap((text) => {
    const message = JSON.parse(text) as {
      type?: string;
      command?: { id?: string; payload?: { input?: { text?: string }[] } };
    };
    return message.type === "command" && message.command?.id === `${id}:retry`
      ? [message.command.payload?.input?.[0]?.text]
      : [];
  });

test("an edit asked for while a retry is on its way waits, and the retry sends the original", async () => {
  const { owner, inbox, thread, sendId } = await failedSendThread("retry-first");
  thread.handle({ type: "retrySend", id: sendId, requestId: "r1" });
  inboxAction(
    owner,
    { kind: "editSend", commandId: sendId, text: "Edited too late" },
    "x1",
    pump,
    inbox,
  );
  await until(() => words("x1"), "the edit's answer");
  expect(words("x1")).toMatchObject({ ok: false });
  expect(words("x1")?.message).toMatch(/being sent again/);
  await until(() => latest("admission", "r1"), "the retry");
  expect(retried(sendId)).toEqual([refuseOnce.text]);
  inbox();
});

test("a retry asked for while an edit is being saved waits, then sends the edited words", async () => {
  const { owner, inbox, thread, sendId } = await failedSendThread("edit-first");
  inboxAction(
    owner,
    { kind: "editSend", commandId: sendId, text: "Ship it today" },
    "x2",
    pump,
    inbox,
  );
  thread.handle({ type: "retrySend", id: sendId, requestId: "r2" });
  await until(() => latest("admission", "r2"), "the retry's answer");
  expect(latest("admission", "r2")).toMatchObject({ ok: false });
  expect(String(latest("admission", "r2")?.message)).toMatch(/edit is being saved/);
  await until(() => words("x2")?.ok, "the saved edit");
  thread.handle({ type: "retrySend", id: sendId, requestId: "r3" });
  await until(() => latest("admission", "r3")?.ok, "the retry");
  expect(retried(sendId)).toEqual(["Ship it today"]);
  inbox();
});

test("once a send went again, the older attempt steps aside and can't be edited", async () => {
  const { owner, inbox, thread, sendId } = await failedSendThread("superseded");
  thread.handle({ type: "retrySend", id: sendId, requestId: "r4" });
  await until(() => latest("admission", "r4")?.ok, "the retry");
  await until(() => latest("pending", sendId)?.row === null, "the older row gone");
  inboxAction(owner, { kind: "editSend", commandId: sendId, text: "Too late" }, "x3", pump, inbox);
  await until(() => words("x3"), "the answer");
  expect(words("x3")?.ok).toBe(false);
  thread.handle({ type: "retrySend", id: sendId, requestId: "r5" });
  await until(() => latest("admission", "r5"), "the second retry's answer");
  expect(latest("admission", "r5")?.ok).toBe(false);
  inbox();
});
