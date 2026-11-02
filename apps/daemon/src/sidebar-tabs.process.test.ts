import { afterEach, expect, test } from "vitest";
import { Thread, type ServerMessage, type ThreadListEntry } from "@ace/protocol";
import { threadTabs } from "@ace/ui-core/thread-place";
import { fixture } from "./socket-test-support.ts";
import { SidebarPlacement } from "./sidebar-placement.ts";
import { subscribe } from "./subscription.ts";

/*
 * The daemon places every listed thread in the Threads panel and keeps the places current over
 * a real store (temp SQLite) and its live window: what clients render as given.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

const day = 86_400_000;
const now = 100 * day;

async function world() {
  const f = await fixture();
  cleanup.push(() => f.close());
  const placement = new SidebarPlacement(f.store.sidebarToken(), () => now);
  const add = (id: string, patch: Record<string, unknown>) => {
    const thread = Thread.parse({
      id,
      workspaceId: f.thread.workspaceId,
      title: id,
      provider: "codex",
      status: { state: "done" },
      createdAt: 1,
      updatedAt: now - day,
      activityAt: now - day,
      hasSentMessage: true,
      ...patch,
    });
    f.store.appendEvents(id, [{ type: "thread.created", thread }], now);
  };
  return { ...f, placement, add };
}

/** One client's copy of a list subscription: the snapshot, then each patch, as sent. */
function follow(
  f: Awaited<ReturnType<typeof world>>,
  resume?: { revision: number; epoch: string },
) {
  const messages: ServerMessage[] = [];
  const held = new Map<string, ThreadListEntry>();
  let revision = 0;
  let epoch = "";
  const stop = subscribe(
    f.store,
    "list",
    { kind: "threads", window: { limit: 20, ...(resume ? { resume } : {}) } },
    undefined,
    5000,
    (message) => {
      messages.push(message);
      if (message.type === "snapshot" && message.view.kind === "threads") {
        for (const entry of Object.values(message.view.threads)) held.set(entry.id, entry);
        revision = message.view.window?.revision ?? 0;
        epoch = message.view.window?.epoch ?? "";
      }
      if (message.type === "threads.patch") {
        for (const entry of Object.values(message.threads)) held.set(entry.id, entry);
        for (const id of message.removed) held.delete(id);
        revision = message.window.revision ?? revision;
        epoch = message.window.epoch ?? epoch;
      }
    },
    250,
    undefined,
    false,
    undefined,
    f.placement,
  );
  cleanup.push(async () => stop());
  return {
    messages,
    held,
    stop,
    resume: () => ({ revision, epoch }),
    /** The tabs exactly as the daemon placed them: no rule runs here. */
    tabs: (ids?: readonly string[]) =>
      threadTabs(
        [...held.values()].filter((entry) => !ids || ids.includes(entry.id)),
        (entry) => entry.place,
      ),
  };
}

const settled = { settledAt: now - 5 * day, settledReason: "manual", readAt: now - 5 * day };

test("a settled thread held at a usage limit or with only a command left running stays in Settled", async () => {
  const f = await world();
  f.add("limited", { status: { state: "limited", until: now + day }, ...settled });
  f.add("rate", { status: { state: "waiting", on: "rate_limit" }, ...settled });
  f.add("server", { status: { state: "waiting", on: "background_task" }, ...settled });
  f.add("works", { status: { state: "working", agents: 1 }, ...settled });
  f.add("asks", { status: { state: "needs_you", interactions: 1 }, ...settled });
  const list = follow(f);
  const tabs = list.tabs(["limited", "rate", "server", "works", "asks"]);
  expect(tabs.settled.toSorted()).toEqual(["limited", "rate", "server"]);
  expect(tabs.inbox).toEqual(["asks", "works"]);
});

test("the Inbox goes pinned, needs you, running, unseen, idle; Snoozed soonest first; Settled newest first", async () => {
  const f = await world();
  f.add("idle", { status: { state: "done" }, readAt: now, activityAt: now - 1 });
  f.add("unseen", { status: { state: "done" }, activityAt: now - 2 });
  f.add("runs", { status: { state: "working", agents: 1 }, activityAt: now - 3 });
  f.add("asks", { status: { state: "needs_you", interactions: 1 }, activityAt: now - 4 * day });
  f.add("pin", { pinned: true, pinOrder: 5, readAt: now, activityAt: now - 9 * day });
  f.add("late", { snoozedUntil: now + 2 * day });
  f.add("soon", { snoozedUntil: now + day });
  f.add("old", { ...settled, activityAt: now - 8 * day });
  f.add("new", { ...settled, activityAt: now - 7 * day });
  const ids = ["idle", "unseen", "runs", "asks", "pin", "late", "soon", "old", "new"];
  const tabs = follow(f).tabs(ids);
  expect(tabs.inbox).toEqual(["pin", "asks", "runs", "unseen", "idle"]);
  expect(tabs.pinned).toEqual(["pin"]);
  expect(tabs.snoozed).toEqual(["soon", "late"]);
  expect(tabs.settled).toEqual(["new", "old"]);
});

test("settle, unsettle, snooze, wake and status changes move one thread with a one-entry patch", async () => {
  const f = await world();
  for (let i = 0; i < 30; i++) f.add(`other-${i}`, { readAt: now });
  f.add("t", { status: { state: "done" }, readAt: now, activityAt: now - 1 });
  const list = follow(f);
  const tabOf = () => {
    const tabs = list.tabs(["t"]);
    return tabs.inbox.length ? "inbox" : tabs.snoozed.length ? "snoozed" : "settled";
  };
  const step = (events: Parameters<typeof f.store.appendEvents>[1]) => {
    const before = list.messages.length;
    f.store.appendEvents("t", events, now);
    const patches = list.messages.slice(before);
    expect(patches).toHaveLength(1);
    const patch = patches[0];
    if (patch?.type !== "threads.patch") throw new Error("Missing patch");
    expect(Object.keys(patch.threads)).toEqual(["t"]);
    return tabOf();
  };
  expect(tabOf()).toBe("inbox");
  const settle = { settledAt: now, settledReason: "manual" as const };
  expect(step([{ type: "thread.client.updated", changes: settle }])).toBe("settled");
  // Held at a usage limit, or with only a command left running: it rests in Settled.
  expect(step([{ type: "thread.updated", status: { state: "limited", until: now + day } }])).toBe(
    "settled",
  );
  expect(
    step([{ type: "thread.updated", status: { state: "waiting", on: "background_task" } }]),
  ).toBe("settled");
  expect(
    step([{ type: "thread.client.updated", changes: { settledAt: null, settledReason: null } }]),
  ).toBe("inbox");
  expect(step([{ type: "thread.client.updated", changes: settle }])).toBe("settled");
  // Its agents work again: back in the Inbox (the daemon unsettles working threads).
  expect(step([{ type: "thread.updated", status: { state: "working", agents: 1 } }])).toBe("inbox");
  expect(step([{ type: "thread.updated", status: { state: "done" } }])).toBe("inbox");
  expect(step([{ type: "thread.client.updated", changes: { snoozedUntil: now + day } }])).toBe(
    "snoozed",
  );
  // A request is never hidden by a snooze.
  expect(step([{ type: "thread.updated", status: { state: "needs_you", interactions: 1 } }])).toBe(
    "inbox",
  );
  expect(step([{ type: "thread.updated", status: { state: "done" } }])).toBe("snoozed");
  expect(step([{ type: "thread.client.updated", changes: { snoozedUntil: null } }])).toBe("inbox");
});

test("a reconnect from revision N gets only the threads that moved since, and the same tabs as a fresh list", async () => {
  const f = await world();
  for (let i = 0; i < 40; i++) f.add(`t-${i}`, { readAt: now, activityAt: now - i });
  const first = follow(f);
  const resume = first.resume();
  first.stop();
  // While it was away: one thread settled, one started working.
  f.store.appendEvents(
    "t-5",
    [{ type: "thread.client.updated", changes: { settledAt: now, settledReason: "manual" } }],
    now,
  );
  f.store.appendEvents(
    "t-9",
    [{ type: "thread.updated", status: { state: "working", agents: 1 } }],
    now,
  );
  const again = follow(f, resume);
  const snapshot = again.messages[0];
  if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "threads")
    throw new Error("Missing snapshot");
  expect(Object.keys(snapshot.view.threads).toSorted()).toEqual(["t-5", "t-9"]);
  expect(snapshot.view.keep).toContain("t-0");
  expect(snapshot.view.keep).not.toContain("t-5");
  // The resumed copy: what it held, kept where the daemon says, plus what moved.
  const resumed = new Map(first.held);
  const keep = new Set<string>(snapshot.view.keep);
  for (const id of resumed.keys()) if (!keep.has(id)) resumed.delete(id);
  for (const entry of Object.values(snapshot.view.threads)) resumed.set(entry.id, entry);
  const fresh = follow(f);
  const tabsOf = (held: Map<string, ThreadListEntry>) =>
    threadTabs([...held.values()], (entry) => entry.place);
  expect(tabsOf(resumed)).toEqual(fresh.tabs());
  expect(fresh.tabs().settled).toContain("t-5");
  expect(fresh.tabs().inbox[0]).toBe("t-9");
});

test("a resume from another database or sort, or from ahead of this database, gets the whole window", async () => {
  const f = await world();
  for (let i = 0; i < 5; i++) f.add(`t-${i}`, { readAt: now });
  const first = follow(f);
  const { revision, epoch } = first.resume();
  first.stop();
  for (const resume of [
    { revision, epoch: "another-database:activity:0" },
    { revision: revision + 1000, epoch },
  ]) {
    const again = follow(f, resume);
    const snapshot = again.messages[0];
    if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "threads")
      throw new Error("Missing snapshot");
    expect(snapshot.view.keep).toBeUndefined();
    expect(Object.keys(snapshot.view.threads)).toEqual(expect.arrayContaining(["t-0", "t-4"]));
    again.stop();
  }
});

test("a sort change re-places the open list, sending only threads whose place changed", async () => {
  const f = await world();
  f.add("asks", { status: { state: "needs_you", interactions: 1 }, createdAt: 1 });
  f.add("newer", { readAt: now, createdAt: 9 });
  f.add("rest", { ...settled });
  const list = follow(f);
  expect(list.tabs(["asks", "newer", "rest"]).inbox).toEqual(["asks", "newer"]);
  const before = list.messages.length;
  f.placement.setSort("created");
  const patch = list.messages.at(-1);
  expect(list.messages.length).toBe(before + 1);
  if (patch?.type !== "threads.patch") throw new Error("Missing patch");
  // Settled is placed the same under any sort: it isn't sent again.
  expect(Object.keys(patch.threads)).not.toContain("rest");
  expect(patch.window.epoch).toBe(f.placement.epoch);
  expect(list.tabs(["asks", "newer", "rest"]).inbox).toEqual(["newer", "asks"]);
});
