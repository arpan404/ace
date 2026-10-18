import { CommandPayload, ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { entry } from "./test-entries.fixture.ts";
import {
  inboxGroupRank,
  inboxSections,
  inboxStatus,
  type InboxSection,
  type InboxThread,
  type InboxUnsent,
} from "./mobile-inbox.ts";

/*
 * The native inbox runs one runtime per paired machine: each groups its own threads, and the app
 * merges their sections by rank. These tests hold the merged inbox to what grouping every
 * machine together says.
 */

const now = 1_000_000;
const minute = 60_000;
const on = (machineId: string, value: ReturnType<typeof entry>, unconfirmed = false) => ({
  key: `${machineId}/${value.id}`,
  machineId,
  entry: value,
  unconfirmed,
});

/** What the app does with per-machine sections: order sections by group, rows by rank. */
function merge(parts: InboxSection[][]): Record<string, string[]> {
  const groups = new Map<InboxSection["key"], { label: string; rows: [string, string][] }>();
  for (const sections of parts)
    for (const section of sections) {
      const group = groups.get(section.key) ?? { label: section.label, rows: [] };
      section.keys.forEach((key, index) => group.rows.push([section.ranks[index] ?? "", key]));
      groups.set(section.key, group);
    }
  return Object.fromEntries(
    [...groups.entries()]
      .toSorted(([a], [b]) => inboxGroupRank(a) - inboxGroupRank(b))
      .map(([, group]) => [
        group.label,
        group.rows.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, key]) => key),
      ]),
  );
}
const combined = (threads: InboxThread[], unsent: InboxUnsent[] = []) =>
  Object.fromEntries(
    inboxSections(threads, unsent, now).map((section) => [section.label, section.keys]),
  );

const mac = [
  on("mac", entry("t1", { state: "working", agents: 1 }, now - 3 * minute)),
  on("mac", entry("waits", { state: "waiting", on: "background_task" }, now)),
  on("mac", entry("asks", { state: "needs_you", interactions: 1 }, now - minute)),
  on("mac", entry("old", { state: "done" }, now - 9 * minute)),
  on("mac", entry("nap", { state: "done" }, now, { snoozedUntil: now + 30 * minute })),
];
const linux = [
  on("linux", entry("t1", { state: "working", agents: 2 }, now - minute)),
  on("linux", entry("fresh", { state: "done" }, now - 2 * minute)),
  on("linux", entry("broke", { state: "failed" }, now - 4 * minute)),
  on("linux", entry("nap", { state: "done" }, now, { snoozedUntil: now + 5 * minute })),
];

test("machines grouped on their own runtimes merge into the order grouping them together gives", () => {
  const merged = merge([inboxSections(mac, [], now), inboxSections(linux, [], now)]);
  expect(merged).toEqual(combined([...mac, ...linux]));
  expect(merged).toEqual({
    "Needs you": ["mac/asks", "linux/broke"],
    Working: ["linux/t1", "mac/t1", "mac/waits"],
    Done: ["linux/fresh", "mac/old"],
    Snoozed: ["linux/nap", "mac/nap"],
  });
});

test("the same thread id on two machines keeps two rows with their own status", () => {
  const ours = on("mac", entry("t1", { state: "needs_you", interactions: 1 }, now));
  const theirs = on("linux", entry("t1", { state: "done" }, now));
  expect(merge([inboxSections([ours], [], now), inboxSections([theirs], [], now)])).toEqual({
    "Needs you": ["mac/t1"],
    Done: ["linux/t1"],
  });
  expect(inboxStatus(ours).label).toBe("Needs you");
  expect(inboxStatus(theirs).label).toBe("Done");
});

test("an unconfirmed copy from an unreachable machine reads Syncing; the other machine is untouched", () => {
  // linux is unreachable since launch: its rows were restored from disk, unconfirmed by the daemon.
  const offline = linux.map((thread) => on("linux", thread.entry, true));
  offline.push(on("linux", entry("asks", { state: "needs_you", interactions: 1 }, now), true));
  const merged = merge([inboxSections(mac, [], now), inboxSections(offline, [], now)]);
  expect(merged).toEqual({
    "Needs you": ["linux/asks", "mac/asks"],
    Working: ["mac/t1", "mac/waits"],
    Syncing: ["linux/t1", "linux/fresh", "linux/broke"],
    Done: ["mac/old"],
    Snoozed: ["linux/nap", "mac/nap"],
  });
  for (const thread of offline.filter((row) => !row.key.endsWith("/asks")))
    expect(inboxStatus(thread)).toEqual({ label: "Syncing", token: "neutral" });
});

function send(machineId: string, id: string): InboxUnsent {
  const payload = CommandPayload.parse({
    type: "thread.send",
    threadId: ThreadId.parse("t1"),
    input: [{ type: "text", text: id }],
  });
  if (payload.type !== "thread.send") throw new Error("expected a send");
  return {
    key: `${machineId}/${id}`,
    machineId,
    send: {
      commandId: id,
      itemId: `input:${id}`,
      threadId: "t1",
      payload,
      state: "sent",
      waiting: false,
    },
  };
}

test("held sends from two machines list each machine's outbox in its own order", () => {
  const macSends = [send("mac", "z"), send("mac", "a")];
  const linuxSends = [send("linux", "m")];
  expect(
    merge([inboxSections([], macSends, now), inboxSections([], linuxSends, now)]).Unsent,
  ).toEqual(["linux/m", "mac/z", "mac/a"]);
  expect(combined([], [...macSends, ...linuxSends]).Unsent).toEqual(["linux/m", "mac/z", "mac/a"]);
});
