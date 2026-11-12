import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import type { ThreadListEntry } from "@ace/protocol";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { followInbox, inboxAction, type InboxClock } from "./inbox.ts";
import { inboxRequests } from "./inbox-manage.ts";
import type { SnoozeAnswer } from "./inbox-snooze.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * Snoozing from the phone as the web's Snooze menu does: until an event the row offers, or a
 * time, each with Undo that puts the thread back as it was.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

const phoneNow = 5_000_000;
const hour = 3_600_000;
const clock: InboxClock = {
  now: () => phoneNow,
  set: (delay, run) => {
    const timer = setTimeout(run, Math.min(delay, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  },
};

function finished(daemon: FakeDaemon, id: string) {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: id,
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
}
function working(daemon: FakeDaemon, id: string) {
  daemon.createThread({
    id,
    workspaceId: "ace",
    title: id,
    provider: "codex",
    hasSentMessage: true,
  });
  daemon.apply(id, [facts.rootAgent("codex"), facts.turn("root")]);
}
/** A live thread waiting on its background shell: it can be settled while its snooze waits. */
function waiting(daemon: FakeDaemon, id: string) {
  finished(daemon, id);
  daemon.updateThread(id, { status: { state: "waiting", on: "background_task" } }, 2_000);
}

function listed(daemon: FakeDaemon, id: string): ThreadListEntry | undefined {
  const view = daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

type Row = {
  wake: string | null;
  snoozeWake: string | null;
  snoozeEvents: { id: string; label: string; detail: string }[];
  group: string | null;
};
const row = (sink: RecordingSink, id: string) =>
  (sink.read(`inbox:${id}`) as { row: Row | null } | undefined)?.row ?? undefined;

let requests = 0;
async function following(seed: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const sink = new RecordingSink();
  const inbox = followInbox(client, "mac", sink, clock);
  closers.push(inbox);
  const ask = inboxRequests(client, inbox.organizer, clock, sink);
  const snooze = (threadId: string, choice: string) =>
    ask(
      { type: "inbox.snooze", threadId, choice },
      `snooze-${++requests}`,
    ) as Promise<SnoozeAnswer>;
  /** Undo's put-back, answered once the machine took it. */
  const putBack = async (threadId: string, undo: SnoozeAnswer["undo"]) => {
    const id = `back-${++requests}`;
    inboxAction(client, { kind: "snoozeAt", threadId, ...undo }, id, sink, inbox);
    await until(() => sink.read(`receipt:${id}`) !== undefined, "the put-back's answer");
    return sink.read(`receipt:${id}`);
  };
  return { daemon, sink, snooze, putBack, ask };
}

test("a working thread snoozes until it needs you, and its row says that, not the backstop date", async () => {
  const { daemon, sink, snooze } = await following((machine) => working(machine, "busy"));
  await until(() => row(sink, "busy") !== undefined, "the row");
  expect(row(sink, "busy")?.snoozeEvents).toEqual([
    {
      id: "needs_you",
      label: "Until it needs you",
      detail: "Returns on a question, a failure or when it finishes",
    },
  ]);

  const answer = await snooze("busy", "needs_you");
  expect(answer).toMatchObject({
    saved: true,
    toast: "Snoozed until it needs you · busy",
    undo: { until: null, wake: null },
  });
  await until(() => listed(daemon, "busy")?.snoozeWake?.on === "needs_you", "the machine's wake");
  // Its time is only the backstop, so nothing sleeps for good.
  expect(listed(daemon, "busy")?.snoozedUntil).toBe(phoneNow + 30 * 24 * hour);
  expect(row(sink, "busy")).toMatchObject({
    wake: "until it needs you",
    snoozeWake: "needs_you",
    group: "snoozed",
  });
});

test("a finished thread offers no event snooze, and the machine refuses one asked anyway", async () => {
  const { sink, snooze } = await following((machine) => finished(machine, "rest"));
  await until(() => row(sink, "rest") !== undefined, "the row");
  expect(row(sink, "rest")?.snoozeEvents).toEqual([]);
  await snooze("rest", "needs_you");
  await until(
    () => (sink.read("receipt:snooze-" + requests) as { ok?: boolean } | undefined)?.ok === false,
    "the refusal",
  );
  expect(row(sink, "rest")?.group).not.toBe("snoozed");
});

test("Undo after a snooze brings the row back to the inbox", async () => {
  const { daemon, sink, snooze, putBack } = await following((machine) => finished(machine, "a"));
  await until(() => row(sink, "a") !== undefined, "the row");
  const answer = await snooze("a", "hour");
  expect(answer.toast).toMatch(/^Snoozed until .+ · a$/);
  await until(() => listed(daemon, "a")?.snoozedUntil === phoneNow + hour, "the snooze");
  expect(row(sink, "a")?.group).toBe("snoozed");

  expect(await putBack("a", answer.undo)).toMatchObject({ ok: true });
  await until(() => listed(daemon, "a")?.snoozedUntil === undefined, "awake again");
  expect(row(sink, "a")?.group).not.toBe("snoozed");
});

test("Undo of a snooze over another puts the first back with the event it waited for", async () => {
  const { daemon, snooze, putBack } = await following((machine) => working(machine, "busy"));
  await until(() => listed(daemon, "busy") !== undefined, "the thread");
  await snooze("busy", "needs_you");
  await until(() => listed(daemon, "busy")?.snoozeWake?.on === "needs_you", "the first snooze");
  const first = listed(daemon, "busy")?.snoozedUntil;

  const second = await snooze("busy", "tomorrow");
  expect(second.undo).toEqual({ until: first, wake: "needs_you" });
  await until(() => listed(daemon, "busy")?.snoozeWake === undefined, "the second snooze");

  await putBack("busy", second.undo);
  await until(() => listed(daemon, "busy")?.snoozeWake?.on === "needs_you", "the first, back");
  expect(listed(daemon, "busy")?.snoozedUntil).toBe(first);
});

test("Undo whose old snooze the machine finds over wakes the thread instead of leaving the new one", async () => {
  const { daemon, snooze, putBack } = await following((machine) => finished(machine, "a"));
  await until(() => listed(daemon, "a") !== undefined, "the thread");
  await snooze("a", "monday");
  await until(() => listed(daemon, "a")?.snoozedUntil !== undefined, "the snooze");

  // The phone's clock still gave the old snooze time to run; the machine's has passed it.
  expect(await putBack("a", { until: 1, wake: null })).toMatchObject({ ok: true, message: "" });
  await until(() => listed(daemon, "a")?.snoozedUntil === undefined, "awake");
});

test("Settle's Undo puts the snooze back with the event it waited for", async () => {
  const { daemon, sink, snooze, putBack, ask } = await following((machine) =>
    waiting(machine, "shell"),
  );
  await until(() => row(sink, "shell") !== undefined, "the row");
  await snooze("shell", "needs_you");
  await until(() => row(sink, "shell")?.snoozeWake === "needs_you", "the row's wake");
  const backstop = listed(daemon, "shell")?.snoozedUntil ?? null;

  await ask({ type: "inbox.bulk", action: "settle", threadIds: ["shell"] }, "settle");
  await until(() => listed(daemon, "shell")?.snoozeWake === undefined, "settled, snooze cleared");
  await ask({ type: "inbox.bulk", action: "undoSettle", threadIds: ["shell"] }, "undo");
  expect(await putBack("shell", { until: backstop, wake: "needs_you" })).toMatchObject({
    ok: true,
  });
  expect(listed(daemon, "shell")?.snoozeWake?.on).toBe("needs_you");
  expect(listed(daemon, "shell")?.settledAt).toBeUndefined();
});
