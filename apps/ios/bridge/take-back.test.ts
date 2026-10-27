import {
  commands,
  connect,
  fixture,
  latest,
  open,
  pump,
  queueRemoves,
  refuseOnce,
  reset,
  sent,
  until,
} from "./thread-harness.ts";
import { afterEach, expect, test } from "vitest";
import { facts, fixtureImage, type FakeDaemon } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId, type QueuePage } from "@ace/protocol";
import { followDismissed, keepNone } from "./dismissed-sends.ts";
import { followInbox, inboxAction } from "./inbox.ts";
import { queueHold } from "./queue-hold.ts";
import { followTakeBacks, recoverTakeBacks, type TakeBackRecord } from "./take-back-ledger.ts";

afterEach(reset);

interface Queue {
  messages: { id: string; text: string }[];
  notSent: { id: string; text: string; attachments: number } | null;
}
const queue = () => latest("thread.queue") as Queue | undefined;
const words = (id: string) =>
  latest("words", id) as
    | { ok: boolean; text: string | null; message: string; record?: string }
    | undefined;

/** The machine's store as Swift's DurableStore keeps one value. */
function store() {
  const kept = { value: "" };
  return {
    kept,
    native: {
      load: async () => kept.value,
      save: async (value: string) => {
        kept.value = value;
      },
    },
  };
}

function seed(id: string): FakeDaemon {
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
  fake.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  return fake;
}

/** A held head (`first`) the daemon kept as not sent, one more message behind it. */
async function heldThread(
  id: string,
  first: string,
  options: {
    context?: { mentions: []; attachments: { sha256: string }[] };
    outbox?: { value: string | null };
  } = {},
) {
  const fake = seed(id);
  // A file this thread holds, as an upload from the phone leaves it.
  if (options.context)
    fake.seedServices({ attachmentImages: [{ threadId: id, name: fixtureImage.name }] });
  fake.holdQueue(id, "not_sent", { title: "Codex couldn't start.", code: "session_start_failed" });
  for (const [command, text, context] of [
    ["held-1", first, options.context],
    ["held-2", "Then write the tests", undefined],
  ] as const)
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
  const owner = connect(fake, options.outbox ? { outbox: options.outbox } : {});
  const ledger = followTakeBacks(store().native);
  const thread = open(owner, id, undefined, ledger);
  const held = await until(() => queue()?.notSent ?? undefined, "the message that wasn't sent");
  return { fake, owner, thread, held, ledger };
}

test("Edit hands the words back only after the daemon's receipt for the removal", async () => {
  const { thread, held } = await heldThread("edit-ok", "Add retries to the webhook handler");
  queueRemoves.hold = true;
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: true, requestId: "e1" });
  await until(() => commands("queue.remove").length === 1, "the removal on its way");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(words("e1")).toBeUndefined();
  queueRemoves.release();
  await until(() => words("e1"), "the words");
  expect(words("e1")).toMatchObject({ ok: true, text: "Add retries to the webhook handler" });
});

test("a removal the daemon refuses keeps the message and hands nothing back", async () => {
  const { thread, held, ledger } = await heldThread("edit-refused", "Add retries to the handler");
  queueRemoves.conflict = true;
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: true, requestId: "e2" });
  await until(() => words("e2"), "the answer");
  expect(words("e2")).toMatchObject({ ok: false, text: null });
  expect(words("e2")?.message).toMatch(/changed/);
  expect(queue()?.notSent?.id).toBe(held.id);
  // Nothing is left to give back at the next launch.
  expect(await ledger.kept()).toEqual([]);
});

test("a long held message comes back whole, never as its shortened preview", async () => {
  const long = `Refactor ${"the relay outbox ".repeat(700)}END`;
  const { thread, held } = await heldThread("edit-long", long);
  expect(held.text.length).toBeLessThan(long.length);
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: false, requestId: "r1" });
  await until(() => words("r1"), "the full words");
  expect(words("r1")?.text).toBe(long);
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: true, requestId: "e3" });
  await until(() => words("e3"), "the taken-back words");
  expect(words("e3")?.text).toBe(long);
});

test("Edit of a held message with uploaded files changes its words and keeps the files", async () => {
  const sha256 = fixtureImage.sha256;
  const { owner, thread, held } = await heldThread("edit-files", "Look at this screenshot", {
    context: { mentions: [], attachments: [{ sha256 }] },
  });
  expect(held.attachments).toBe(1);
  // Taking it back would leave its files behind: refused, nothing removed.
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: true, requestId: "t1" });
  await until(() => words("t1"), "the answer");
  expect(words("t1")?.ok).toBe(false);
  expect(commands("queue.remove")).toHaveLength(0);
  // The view's Edit: the full words, changed where the message waits.
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: false, requestId: "t2" });
  await until(() => words("t2"), "the words to edit");
  thread.handle({
    type: "queue",
    messageId: held.id,
    change: { kind: "words", text: "Look at this screenshot again" },
    requestId: "t3",
  });
  await until(() => queue()?.notSent?.text === "Look at this screenshot again", "the new words");
  const { queue: page } = await owner.request({
    type: "queue.get",
    threadId: ThreadId.parse("edit-files"),
  });
  expect(page.messages.find((message) => message.id === held.id)?.context?.attachments).toEqual([
    { sha256 },
  ]);
});

test("Edit of a failed send hands back its full words once its dismissal is saved", async () => {
  const fake = seed("send-long");
  fake.apply("send-long", [facts.endTurn("root")]);
  const owner = connect(fake);
  const ledger = followTakeBacks(store().native);
  const inbox = followInbox(
    owner,
    "machine",
    pump,
    {
      now: () => Date.now(),
      set: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
    undefined,
    undefined,
    undefined,
    followDismissed(store().native),
    ledger,
  );
  const thread = open(owner, "send-long");
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
  const shown = latest("pending", id)?.row as { text: string } | undefined;
  expect(shown?.text.length).toBeLessThan(long.length);
  inboxAction(owner, { kind: "takeBackSend", commandId: id }, "s1", pump, inbox);
  await until(() => words("s1"), "the words");
  expect(words("s1")?.text).toBe(long);
  // Acknowledged once the phone has them in its draft: nothing left to give back.
  inboxAction(owner, { kind: "takeBackAck", id: String(words("s1")?.record) }, "a1", pump, inbox);
  await until(async () => (await ledger.kept()).length === 0, "the record settled");
  inbox();
});

test("words whose removal committed come back after the runtime stopped before the phone had them", async () => {
  const outbox = { value: null as string | null };
  const disk = store();
  const fake = seed("relaunch");
  fake.holdQueue("relaunch", "not_sent", { title: "Codex couldn't start.", code: "x" });
  fake.command({
    id: CommandId.parse("relaunch-held"),
    deviceId: DeviceId.parse("seed"),
    payload: {
      type: "thread.send",
      threadId: ThreadId.parse("relaunch"),
      input: [{ type: "text", text: "Ship the release notes" }],
      delivery: "queue",
    },
  });
  const first = connect(fake, { outbox });
  const thread = open(first, "relaunch", undefined, followTakeBacks(disk.native));
  const held = await until(() => queue()?.notSent ?? undefined, "the held message");
  // The removal is saved in the outbox, then the runtime stops before any receipt.
  queueRemoves.hold = true;
  thread.handle({ type: "queueWords", messageId: held.id, takeBack: true, requestId: "k1" });
  await until(
    () => sent.some((text) => text.includes('"type":"queue.remove"')),
    "the removal sent",
  );
  await first.close();
  expect(words("k1")).toBeUndefined();
  // Relaunch: the outbox replays the removal; the kept record gives the words back.
  queueRemoves.hold = false;
  const second = connect(fake, { outbox });
  const given: TakeBackRecord[] = [];
  await recoverTakeBacks(followTakeBacks(disk.native), second, keepNone, (entry) =>
    given.push(entry),
  );
  expect(given.map((entry) => [entry.threadId, entry.text])).toEqual([
    ["relaunch", "Ship the release notes"],
  ]);
  await second.close();
});

test("a record whose removal never reached the outbox is dropped, since the original is still queued", async () => {
  const disk = store();
  const ledger = followTakeBacks(disk.native);
  const { owner, held } = await heldThread("never-sent", "Keep me queued");
  await ledger.record({
    id: "record-1",
    threadId: "never-sent",
    text: "Keep me queued",
    kind: "queue",
    source: held.id,
    removal: "removal-never-saved",
  });
  const given: TakeBackRecord[] = [];
  await recoverTakeBacks(followTakeBacks(disk.native), owner, keepNone, (entry) =>
    given.push(entry),
  );
  expect(given).toEqual([]);
  expect(await followTakeBacks(disk.native).kept()).toEqual([]);
});

test("files a phone uploaded count as the held message's attachments", () => {
  const threadId = ThreadId.parse("files");
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
        id: CommandId.parse("held-with-files"),
        input: [{ type: "text", text: "Look at this screenshot" }],
        context: { mentions: [], attachments: [{ sha256: "a".repeat(64) }] },
        delivery: "queue",
        state: "queued",
      },
    ],
  };
  const reader = {
    thread: undefined,
    queue: page,
    agent: () => undefined,
    order: [],
    item: () => undefined,
  };
  expect(queueHold(reader, page, 0).notSent?.attachments).toBe(1);
});
