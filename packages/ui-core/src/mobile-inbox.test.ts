import { CommandPayload, ThreadId } from "@ace/protocol";
import type { PendingSend } from "@ace/client";
import { expect, test } from "vitest";
import { entry } from "./test-entries.fixture.ts";
import {
  inboxNextChange,
  inboxSections,
  inboxStatus,
  unsentStatus,
  unsentText,
  type InboxThread,
  type InboxUnsent,
} from "./mobile-inbox.ts";
import { mobileStatus } from "./mobile-status.ts";

const now = 1_000_000;
const minute = 60_000;
const on = (machineId: string, value: ReturnType<typeof entry>, unconfirmed = false) => ({
  key: `${machineId}/${value.id}`,
  machineId,
  entry: value,
  unconfirmed,
});
const sections = (threads: InboxThread[], unsent: InboxUnsent[] = [], at = now) =>
  Object.fromEntries(inboxSections(threads, unsent, at).map((s) => [s.label, s.keys]));

function send(id: string, state: PendingSend["state"], text: string, waiting = false): InboxUnsent {
  const payload = CommandPayload.parse({
    type: "thread.send",
    threadId: ThreadId.parse("t"),
    input: [{ type: "text", text }],
  });
  if (payload.type !== "thread.send") throw new Error("expected a send");
  return {
    key: `mac/${id}`,
    machineId: "mac",
    send: { commandId: id, itemId: `input:${id}`, threadId: "t", payload, state, waiting },
  };
}

test("a finished root whose child still works stays Working, even once settled", () => {
  // The daemon's whole-tree status: the root's turn ended, one child agent still runs.
  const tree = entry("tree", { state: "working", agents: 1 }, now, {
    settledAt: now,
    live: { subagentCount: 1, backgroundTaskCount: 0 },
  });
  const thread = on("mac", tree);
  expect(sections([thread, on("mac", entry("done", { state: "done" }, now))])).toEqual({
    Working: ["mac/tree"],
    Done: ["mac/done"],
  });
  expect(inboxStatus(thread, now)).toEqual({ label: "Working", token: "working" });
});

test("requests lead, a snoozed request stays exposed and a failure asks the person to look", () => {
  const result = sections([
    on("mac", entry("busy", { state: "working", agents: 1 }, now)),
    on("mac", entry("broke", { state: "failed" }, now - minute)),
    on(
      "mac",
      entry("asks", { state: "needs_you", interactions: 1 }, now - 2 * minute, {
        snoozedUntil: now + 60 * minute,
      }),
    ),
  ]);
  expect(result).toEqual({ "Needs you": ["mac/broke", "mac/asks"], Working: ["mac/busy"] });
});

test("Working puts running trees above waiting ones, most recent first", () => {
  const result = sections([
    on("mac", entry("waits", { state: "waiting", on: "background_task" }, now)),
    on("mac", entry("old", { state: "working", agents: 2 }, now - 5 * minute)),
    on("mac", entry("fresh", { state: "working", agents: 1 }, now - minute)),
  ]);
  expect(result.Working).toEqual(["mac/fresh", "mac/old", "mac/waits"]);
});

test("snoozed threads list the soonest wake first and return to their group once it passes", () => {
  const threads = [
    on("mac", entry("later", { state: "done" }, now, { snoozedUntil: now + 90 * minute })),
    on("mac", entry("soon", { state: "done" }, now - 9 * minute, { snoozedUntil: now + minute })),
  ];
  expect(sections(threads)).toEqual({ Snoozed: ["mac/soon", "mac/later"] });
  expect(sections(threads, [], now + 2 * minute)).toEqual({
    Done: ["mac/soon"],
    Snoozed: ["mac/later"],
  });
});

test("a snooze that runs out before its offline machine wakes it reads Snooze ended in Done", () => {
  // The machine is offline: this phone's copy still holds the snooze the daemon would clear.
  const napping = on(
    "mac",
    entry("nap", { state: "done" }, now - 9 * minute, { snoozedUntil: now + minute }),
  );
  expect(sections([napping])).toEqual({ Snoozed: ["mac/nap"] });
  expect(inboxStatus(napping, now)).toEqual({ label: "Done", token: "done" });
  const later = now + minute;
  expect(sections([napping], [], later)).toEqual({ Done: ["mac/nap"] });
  expect(inboxStatus(napping, later)).toEqual({ label: "Snooze ended", token: "done" });
});

test("a live state outranks Snooze ended, and a request still leads", () => {
  const late = now + 2 * minute;
  const busy = on(
    "mac",
    entry("busy", { state: "working", agents: 1 }, now, { snoozedUntil: now + minute }),
  );
  const asks = on(
    "mac",
    entry("asks", { state: "needs_you", interactions: 1 }, now, { snoozedUntil: now + minute }),
  );
  expect(sections([busy, asks], [], late)).toEqual({
    "Needs you": ["mac/asks"],
    Working: ["mac/busy"],
  });
  expect(inboxStatus(busy, late)).toEqual({ label: "Working", token: "working" });
  expect(inboxStatus(asks, late).label).toBe("Needs you");
});

test("the inbox next changes when the soonest pending snooze runs out", () => {
  const threads = [
    on("mac", entry("past", { state: "done" }, now, { snoozedUntil: now - minute })),
    on("mac", entry("later", { state: "done" }, now, { snoozedUntil: now + 90 * minute })),
    on("linux", entry("soon", { state: "done" }, now, { snoozedUntil: now + 5 * minute })),
    on(
      "mac",
      entry("gone", { state: "done" }, now, { snoozedUntil: now + minute, archivedAt: now }),
    ),
    on("mac", entry("awake", { state: "done" }, now)),
  ];
  expect(inboxNextChange(threads, now)).toBe(now + 5 * minute);
  expect(inboxNextChange(threads, now + 5 * minute)).toBe(now + 90 * minute);
  expect(inboxNextChange(threads, now + 90 * minute)).toBeUndefined();
});

test("an unconfirmed copy claims neither done nor working, but keeps a request exposed", () => {
  const done = on("mac", entry("done", { state: "done" }, now), true);
  const working = on("mac", entry("busy", { state: "working", agents: 1 }, now), true);
  const asks = on("mac", entry("asks", { state: "needs_you", interactions: 1 }, now), true);
  expect(sections([done, working, asks])).toEqual({
    "Needs you": ["mac/asks"],
    Syncing: ["mac/busy", "mac/done"],
  });
  expect(inboxStatus(done, now)).toEqual({ label: "Syncing", token: "neutral" });
  expect(inboxStatus(asks, now)).toEqual({ label: "Needs you", token: "needsYou" });
});

test("the same thread id on two machines stays two rows", () => {
  const result = sections([
    on("mac", entry("t1", { state: "done" }, now)),
    on("linux", entry("t1", { state: "done" }, now - minute)),
  ]);
  expect(result.Done).toEqual(["mac/t1", "linux/t1"]);
});

test("archived, deleted and never-sent threads stay out of the inbox", () => {
  const result = sections([
    on("mac", entry("archived", { state: "done" }, now, { archivedAt: now })),
    on("mac", entry("deleted", { state: "done" }, now, { deletedAt: now })),
    on("mac", entry("draft", { state: "new" }, now, { hasSentMessage: false })),
  ]);
  expect(result).toEqual({});
});

test("Unsent holds only sends the SDK still owns, in outbox order", () => {
  const result = sections(
    [],
    [
      send("b", "sent", "second"),
      send("a", "accepted", "admitted"),
      send("c", "failed", "third"),
      send("d", "delivered", "done"),
    ],
  );
  expect(result).toEqual({ Unsent: ["mac/b", "mac/c"] });
});

test("an unsent row says when it will go and when it needs the person", () => {
  const held = send("a", "sent", "Tighten the spacing").send;
  expect(unsentStatus(held, false)).toEqual({ label: "Sends on reconnect", token: "neutral" });
  expect(unsentStatus(send("b", "sent", "x", true).send, true).label).toBe(
    "Still waiting for your machine…",
  );
  expect(unsentStatus(send("c", "failed", "x").send, true)).toEqual({
    label: "Not sent",
    token: "needsYou",
  });
  expect(unsentText(held)).toBe("Tighten the spacing");
});

test("a recovery the person must act on outranks the settled status word", () => {
  const stuck = on(
    "mac",
    entry("stuck", { state: "done" }, now, {
      queue: { revision: 1, paused: true, reason: "not_sent", resumeAt: null, pendingCount: 1 },
    }),
  );
  expect(sections([stuck])).toEqual({ "Needs you": ["mac/stuck"] });
  expect(inboxStatus(stuck, now)).toEqual({ label: "Not sent", token: "failed" });
});

test("limited reads in the waiting colour, unresponsive keeps its own, new claims nothing", () => {
  expect(mobileStatus({ state: "limited" })).toEqual({ label: "Limited", token: "waiting" });
  expect(mobileStatus({ state: "unresponsive" })).toEqual({
    label: "Unresponsive",
    token: "unresponsive",
  });
  expect(mobileStatus({ state: "new" })).toEqual({ label: "New", token: "neutral" });
  expect(mobileStatus({ state: "done" })).toEqual({ label: "Done", token: "done" });
});
