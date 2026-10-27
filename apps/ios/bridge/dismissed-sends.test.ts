import { connect, fixture, latest, open, pump, reset, sent, until } from "./thread-harness.ts";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { followDismissed } from "./dismissed-sends.ts";
import { followInbox, inboxAction } from "./inbox.ts";

afterEach(reset);

/** The machine's store, as Swift's DurableStore keeps one value. */
function store(initial = "") {
  const kept = { value: initial };
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

const unsentIds = () => {
  const layout = latest("inbox.sections") as { sections?: { ids: string[] }[] } | undefined;
  return layout?.sections?.flatMap((section) => section.ids) ?? [];
};

test("a discarded failed send leaves the transcript and Unsent, also after a relaunch", async () => {
  const fake = fixture();
  fake.createThread({ id: "gone", workspaceId: "ace", title: "Gone", provider: "codex" });
  fake.apply("gone", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const owner = connect(fake);
  const disk = store();
  const inbox = followInbox(
    owner,
    "machine",
    pump,
    {
      now: () => Date.now(),
      set: (ms, run) => {
        const t = setTimeout(run, ms);
        return () => clearTimeout(t);
      },
    },
    undefined,
    undefined,
    undefined,
    followDismissed(disk.native),
  );
  const thread = open(owner, "gone");
  await until(() => latest("thread.controls"), "composer controls");
  thread.handle({ type: "send", text: "Refuse this once", opposite: false, requestId: "first" });
  const id = await until(() => {
    for (const text of sent) {
      const message = JSON.parse(text) as { type?: string; command?: { id?: string } };
      if (message.type === "command" && message.command?.id) return message.command.id;
    }
    return undefined;
  }, "the attempt");
  await until(
    () => (latest("pending", id)?.row as { state?: string } | null)?.state === "failed",
    "the failed row",
  );
  await until(() => unsentIds().includes(id), "the send listed as unsent");
  inboxAction(owner, { kind: "dismissSend", commandId: id }, "d1", pump, inbox);
  await until(() => latest("admission", "d1")?.ok, "the discard admitted");
  await until(() => latest("pending", id)?.row === null, "the row gone");
  expect(unsentIds()).not.toContain(id);
  expect(JSON.parse(disk.kept.value)).toEqual([id]);
  // The next launch reads the same store: the outbox still holds the failed send, the phone doesn't.
  const relaunched = followDismissed(store(disk.kept.value).native);
  await until(() => relaunched.has(id), "the kept dismissal");
  // Undo shows it again.
  inboxAction(owner, { kind: "restoreSend", commandId: id }, "u1", pump, inbox);
  await until(
    () => (latest("pending", id)?.row as { state?: string } | null)?.state === "failed",
    "the row back",
  );
  inbox();
});

test("a send still on its way can't be discarded", async () => {
  const fake = fixture();
  fake.createThread({ id: "busy", workspaceId: "ace", title: "Busy", provider: "codex" });
  const owner = connect(fake);
  const inbox = followInbox(
    owner,
    "machine",
    pump,
    {
      now: () => Date.now(),
      set: (ms, run) => {
        const t = setTimeout(run, ms);
        return () => clearTimeout(t);
      },
    },
    undefined,
    undefined,
    undefined,
    followDismissed(store().native),
  );
  inboxAction(owner, { kind: "dismissSend", commandId: "not-failed" }, "d2", pump, inbox);
  await until(() => latest("admission", "d2"), "the answer");
  expect(latest("admission", "d2")?.ok).toBe(false);
  inbox();
});
