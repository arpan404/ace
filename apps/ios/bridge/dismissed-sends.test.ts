import { connect, fixture, latest, open, pump, reset, sent, until } from "./thread-harness.ts";
import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { followDismissed } from "./dismissed-sends.ts";
import { followInbox, inboxAction } from "./inbox.ts";

afterEach(reset);

const clock = {
  now: () => Date.now(),
  set: (ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

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

test("a discard made while the kept list still loads keeps what was kept before", async () => {
  let finish: (text: string) => void = () => {};
  const saves: string[] = [];
  const kept = followDismissed({
    load: () => new Promise<string>((resolve) => (finish = resolve)),
    save: async (value) => {
      saves.push(value);
    },
  });
  const dismissing = kept.dismiss("new-send");
  finish(JSON.stringify(["older-send"]));
  expect(await dismissing).toBe(true);
  expect(kept.has("older-send")).toBe(true);
  expect(kept.has("new-send")).toBe(true);
  expect(JSON.parse(saves.at(-1) ?? "[]")).toEqual(["older-send", "new-send"]);
});

test("a discard whose save fails is refused and the failed send stays", async () => {
  const fake = fixture();
  fake.createThread({ id: "unsaved", workspaceId: "ace", title: "Unsaved", provider: "codex" });
  fake.apply("unsaved", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const owner = connect(fake);
  const dismissed = followDismissed({
    load: async () => "",
    save: async () => {
      throw new Error("disk full");
    },
  });
  const inbox = followInbox(
    owner,
    "machine",
    pump,
    clock,
    undefined,
    undefined,
    undefined,
    dismissed,
  );
  const thread = open(owner, "unsaved");
  await until(() => latest("thread.controls"), "composer controls");
  thread.handle({ type: "send", text: "Refuse this once", opposite: false, requestId: "first" });
  const id = await until(
    () =>
      owner
        .pendingSends()
        .getSnapshot()
        .find((send) => send.state === "failed")?.commandId,
    "the failed send",
  );
  inboxAction(owner, { kind: "dismissSend", commandId: id }, "d3", pump, inbox);
  await until(() => latest("admission", "d3"), "the answer");
  expect(latest("admission", "d3")?.ok).toBe(false);
  expect(dismissed.has(id)).toBe(false);
  expect((latest("pending", id)?.row as { state?: string } | null)?.state).toBe("failed");
  inbox();
});
