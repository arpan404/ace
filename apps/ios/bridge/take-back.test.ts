import {
  commands,
  connect,
  fixture,
  latest,
  open,
  queueRemoves,
  reset,
  until,
} from "./thread-harness.ts";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { CommandId, ThreadId, type QueuePage } from "@ace/protocol";
import { queueHold } from "./queue-hold.ts";

afterEach(reset);

interface Queue {
  messages: { id: string; text: string }[];
  notSent: { id: string; text: string; attachments: number } | null;
}
const queue = () => latest("thread.queue") as Queue | undefined;
const words = (id: string) =>
  latest("words", id) as { ok: boolean; text: string | null; message: string } | undefined;

async function heldThread(id: string, first: string) {
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
  fake.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  const thread = open(connect(fake), id);
  await until(() => (latest("thread.controls")?.row as { busy?: boolean })?.busy, "a busy thread");
  thread.handle({ type: "send", text: first, opposite: false, requestId: "q1" });
  thread.handle({ type: "send", text: "Then write the tests", opposite: false, requestId: "q2" });
  await until(() => queue()?.messages.length === 2, "two queued");
  fake.holdQueue(id, "not_sent", { title: "Codex couldn't start.", code: "session_start_failed" });
  const held = await until(() => queue()?.notSent ?? undefined, "the message that wasn't sent");
  return { thread, held };
}

test("Edit hands the words back only after the daemon removed the message", async () => {
  const { thread, held } = await heldThread("edit-ok", "Add retries to the webhook handler");
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: true, requestId: "e1" });
  await until(() => words("e1"), "the words");
  expect(words("e1")).toMatchObject({ ok: true, text: "Add retries to the webhook handler" });
  expect(commands("queue.remove")).toHaveLength(1);
});

test("a removal the daemon refuses keeps the message and hands nothing back", async () => {
  const { thread, held } = await heldThread("edit-refused", "Add retries to the webhook handler");
  queueRemoves.conflict = true;
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: true, requestId: "e2" });
  await until(() => words("e2"), "the answer");
  expect(words("e2")).toMatchObject({ ok: false, text: null });
  expect(words("e2")?.message).toMatch(/changed/);
  expect(queue()?.notSent?.id).toBe(held.id);
});

test("a long message comes back whole, not as its shortened preview", async () => {
  const long = `Refactor ${"the relay outbox ".repeat(700)}end.`;
  expect(long.length).toBeGreaterThan(8192);
  const { thread, held } = await heldThread("edit-long", long);
  expect(held.text.length).toBeLessThan(long.length);
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: false, requestId: "r1" });
  await until(() => words("r1"), "the full words");
  expect(words("r1")?.text).toBe(long);
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: true, requestId: "e3" });
  await until(() => words("e3"), "the taken-back words");
  expect(words("e3")?.text).toBe(long);
});

test("files a phone uploaded count as the held message's attachments, so Edit keeps them", () => {
  const threadId = ThreadId.parse("files");
  const id = CommandId.parse("held-with-files");
  const page: QueuePage = {
    threadId,
    revision: 3,
    paused: true,
    reason: "not_sent",
    resumeAt: null,
    total: 1,
    next: null,
    messages: [
      {
        id,
        input: [{ type: "text", text: "Look at this screenshot" }],
        context: { mentions: [], attachments: [{ sha256: "a".repeat(64) }] },
        delivery: "queue",
        state: "queued",
      },
    ],
  };
  const store = {
    thread: undefined,
    queue: page,
    agent: () => undefined,
    order: [],
    item: () => undefined,
  };
  expect(queueHold(store, page, 0).notSent?.attachments).toBe(1);
});
