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
