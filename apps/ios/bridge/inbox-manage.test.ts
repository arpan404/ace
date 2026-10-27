import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import type { ThreadListEntry } from "@ace/protocol";
import { FakeDaemon, facts } from "@ace/fake-daemon";
import { followInbox, inboxAction, type InboxClock } from "./inbox.ts";
import { inboxRequests, type BulkOutcome } from "./inbox-manage.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The web's remaining thread actions on the phone's inbox: mark unread, auto-settle, move to
 * another project and delete, one thread or several at once. Each shows on its row before the
 * machine answers and is the machine's once recorded.
 */

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

class Clock implements InboxClock {
  now = () => 5_000_000;
  set = (delay: number, run: () => void) => {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  };
}

function finished(daemon: FakeDaemon, id: string, workspaceId = "ace") {
  daemon.createThread({ id, workspaceId, title: id, provider: "codex", hasSentMessage: true });
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

function listed(daemon: FakeDaemon, id: string): ThreadListEntry | undefined {
  const view = daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? view.threads[id] : undefined;
}

async function following(seed: (daemon: FakeDaemon) => void) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const sink = new RecordingSink();
  const clock = new Clock();
  const inbox = followInbox(client, "mac", sink, clock);
  closers.push(inbox);
  const act = (action: Record<string, unknown>, requestId: string) =>
    inboxAction(client, action, requestId, sink, inbox);
  const ask = inboxRequests(client, inbox.organizer, clock, sink);
  const request = (raw: Record<string, unknown>) => ask(raw, `req-${++requests}`);
  return { daemon, sink, act, request };
}
let requests = 0;

type Row = {
  menu: string[];
  autoSettle: boolean;
  workspaceId: string;
  look: { unread: boolean };
};
const row = (sink: RecordingSink, id: string) =>
  (sink.read(`inbox:${id}`) as { row: Row | null } | undefined)?.row ?? undefined;
const ids = (sink: RecordingSink) =>
  ((sink.read("inbox:sections") as { sections: { ids: string[] }[] } | undefined)?.sections ?? [])
    .flatMap((section) => section.ids)
    .toSorted();

test("marking a finished thread unread shows on its row at once and on the machine", async () => {
  const { daemon, sink, act } = await following((machine) => finished(machine, "a"));
  await until(() => row(sink, "a") !== undefined, "the row");
  expect(row(sink, "a")?.menu).toContain("unread");

  act({ kind: "read", threadId: "a", unread: true }, "unread-a");
  expect(row(sink, "a")?.look.unread).toBe(true);
  expect(row(sink, "a")?.menu).toContain("read");
  await until(() => listed(daemon, "a")?.unread === true, "the machine's unread");
});

test("turning auto-settle off keeps the thread until settled by hand, and back on", async () => {
  const { daemon, sink, act } = await following((machine) => finished(machine, "a"));
  await until(() => row(sink, "a") !== undefined, "the row");
  expect(row(sink, "a")?.menu).toContain("auto-settle-off");

  act({ kind: "autoSettle", threadId: "a", enabled: false }, "off-a");
  expect(row(sink, "a")?.autoSettle).toBe(false);
  expect(row(sink, "a")?.menu).toContain("auto-settle-on");
  await until(() => listed(daemon, "a")?.autoSettle === false, "the machine's setting");

  act({ kind: "autoSettle", threadId: "a", enabled: true }, "on-a");
  await until(() => listed(daemon, "a")?.autoSettle !== false, "auto-settle back on");
  expect(row(sink, "a")?.autoSettle).toBe(true);
});

test("moving a thread puts it in the other project before the machine records it", async () => {
  const { daemon, sink, act } = await following((machine) => {
    finished(machine, "a");
    finished(machine, "elsewhere", "notes");
  });
  await until(() => row(sink, "a") !== undefined, "the row");

  act({ kind: "move", threadId: "a", workspaceId: "notes" }, "move-a");
  expect(row(sink, "a")?.workspaceId).toBe("notes");
  await until(() => listed(daemon, "a")?.workspaceId === "notes", "the machine's move");
  expect(sink.read("admission:move-a")).toMatchObject({ ok: true });
});

test("deleting finished threads removes them, and one still working asks to stop first", async () => {
  const { daemon, sink, request } = await following((machine) => {
    finished(machine, "a");
    finished(machine, "b");
    working(machine, "live");
  });
  await until(() => ids(sink).length === 3, "the inbox");

  const question = (await request({ type: "inbox.deleteQuestion", threadIds: ["a", "live"] })) as {
    confirm: string;
    force: boolean;
  };
  expect(question).toMatchObject({ confirm: "Stop and delete", force: true });

  const plain = (await request({
    type: "inbox.bulk",
    action: "delete",
    threadIds: ["a", "b", "live"],
  })) as BulkOutcome;
  expect(plain.saved.toSorted()).toEqual(["a", "b", "live"]);
  expect(plain.running).toEqual(["live"]);
  expect(plain.refused).toEqual([]);
  // Refused, the working thread is back on the list; the others are gone.
  await until(() => ids(sink).join() === "live", "the deleted rows leaving");

  const forced = (await request({
    type: "inbox.bulk",
    action: "delete",
    threadIds: ["live"],
    force: true,
  })) as BulkOutcome;
  expect(forced.running).toEqual([]);
  await until(() => listed(daemon, "live") === undefined || ids(sink).length === 0, "the stop");
  expect(ids(sink)).toEqual([]);
});

test("settling several threads leaves the one still working alone", async () => {
  const { daemon, sink, request } = await following((machine) => {
    finished(machine, "a");
    working(machine, "live");
  });
  await until(() => ids(sink).length === 2, "the inbox");

  const outcome = (await request({
    type: "inbox.bulk",
    action: "settle",
    threadIds: ["a", "live"],
  })) as BulkOutcome;
  expect(outcome.saved).toEqual(["a"]);
  expect(outcome.skipped).toEqual(["live"]);
  expect(listed(daemon, "a")?.settledAt).toBeDefined();
  expect(listed(daemon, "live")?.settledAt).toBeUndefined();
});

test("archiving several threads at once can be taken back together", async () => {
  const { daemon, sink, request } = await following((machine) => {
    finished(machine, "a");
    finished(machine, "b");
  });
  await until(() => ids(sink).length === 2, "the inbox");

  await request({ type: "inbox.bulk", action: "archive", threadIds: ["a", "b"] });
  expect(listed(daemon, "a")?.archivedAt).toBeDefined();
  expect(listed(daemon, "b")?.archivedAt).toBeDefined();
  await until(() => ids(sink).length === 0, "the rows leaving");

  await request({ type: "inbox.bulk", action: "unarchive", threadIds: ["a", "b"] });
  await until(() => ids(sink).length === 2, "the rows coming back");
});
