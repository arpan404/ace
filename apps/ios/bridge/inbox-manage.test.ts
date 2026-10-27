import { afterEach, expect, test, vi } from "vitest";

await vi.hoisted(async () => {
  const { createNodeHost } = await import("@ace/native-host/node");
  const host = createNodeHost({ now: () => 0 });
  Object.assign(globalThis, { aceHost: { ...host, timer: () => {}, cancelTimer: () => {} } });
});

import { CommandId, DeviceId, ThreadId, type ThreadListEntry } from "@ace/protocol";
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

/** Timers at most 50 ms, so a bulk answer's wait for the machine ends within the test. */
class FastClock extends Clock {
  override set = (delay: number, run: () => void) => {
    const timer = setTimeout(run, Math.min(delay, 50));
    return () => clearTimeout(timer);
  };
}

async function following(seed: (daemon: FakeDaemon) => void, clock: InboxClock = new Clock()) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  seed(daemon);
  await client.start();
  const sink = new RecordingSink();
  const inbox = followInbox(client, "mac", sink, clock);
  closers.push(inbox);
  const act = (action: Record<string, unknown>, requestId: string) =>
    inboxAction(client, action, requestId, sink, inbox);
  const ask = inboxRequests(client, inbox.organizer, clock, sink);
  const request = (raw: Record<string, unknown>) => ask(raw, `req-${++requests}`);
  return { daemon, client, sink, act, request };
}

/** Waits up to 20 s, for what follows a reconnect. */
async function eventually(condition: () => boolean, label: string): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
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
  expect(plain.retry).toMatchObject({ confirm: "Stop and delete", force: true });
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

test("a link another app opens is read by the shared rules", async () => {
  const { request } = await following(() => {});
  expect(await request({ type: "link.read", url: "ace://thread/a?machine=mac" })).toEqual({
    link: { kind: "thread", threadId: "a", machine: "mac" },
  });
  expect(await request({ type: "link.read", url: "javascript:alert(1)" })).toEqual({ link: null });
});

test("search everything ranks commands, projects and threads by the palette's rules", async () => {
  const { sink, request } = await following((machine) => {
    finished(machine, "relay-fix");
    finished(machine, "other", "notes");
  });
  await until(() => ids(sink).length === 2, "the inbox");
  type Answer = {
    commands: { id: string }[];
    projects: { id: string }[];
    threads: { id: string; listed: boolean }[];
  };
  const empty = (await request({
    type: "palette.query",
    query: "",
    commands: true,
    context: { canStart: true, threadOpen: false },
  })) as Answer;
  // Before a query, every command the app can run now, and nothing about the open thread.
  expect(empty.commands.map((command) => command.id)).toContain("new-thread");
  expect(empty.commands.map((command) => command.id)).not.toContain("thread:changes");
  expect(empty.threads).toEqual([]);

  const typed = (await request({
    type: "palette.query",
    query: "relay",
    commands: true,
  })) as Answer;
  expect(typed.threads.map((thread) => thread.id)).toEqual(["relay-fix"]);
  expect(typed.threads[0]?.listed).toBe(true);
  const settings = (await request({
    type: "palette.query",
    query: "dark mode",
    commands: true,
  })) as Answer;
  expect(settings.commands[0]?.id).toBe("settings:appearance");
  const projects = (await request({ type: "palette.query", query: "notes" })) as Answer;
  expect(projects.projects.map((project) => project.id)).toEqual(["notes"]);
  expect(projects.commands).toEqual([]);
});

test("a delete still waiting on the machine is not done: its answer follows under the ticket", async () => {
  const { daemon, sink, request } = await following((machine) => {
    finished(machine, "a");
    working(machine, "live");
  }, new FastClock());
  await until(() => ids(sink).length === 2, "the inbox");
  daemon.refuseConnections(true);

  const first = (await request({
    type: "inbox.bulk",
    action: "delete",
    threadIds: ["a", "live"],
    ticket: "t-1",
  })) as BulkOutcome;
  // Saved on the phone, but nothing is deleted yet: both still wait on the machine.
  expect(first.saved.toSorted()).toEqual(["a", "live"]);
  expect(first.waiting.toSorted()).toEqual(["a", "live"]);
  expect(listed(daemon, "a")?.deletedAt).toBeUndefined();

  daemon.refuseConnections(false);
  type Final = { type: string; outcome: BulkOutcome };
  await eventually(() => sink.read("bulk:t-1") !== undefined, "the final answer");
  const final = (sink.read("bulk:t-1") as Final).outcome;
  expect(final.waiting).toEqual([]);
  expect(final.running).toEqual(["live"]);
  expect(final.retry).toMatchObject({ confirm: "Stop and delete" });
  expect(listed(daemon, "a")).toBeUndefined();
});

test("a settled thread paged out of the phone's list still gets its Undo", async () => {
  const ids40 = Array.from({ length: 40 }, (_, index) => `s-${index}`);
  const { daemon, sink, request } = await following((machine) => {
    for (const id of ids40) {
      finished(machine, id);
      machine.command({
        id: CommandId.parse(`settle-${id}`),
        deviceId: DeviceId.parse("seed"),
        payload: { type: "thread.settle", threadId: ThreadId.parse(id) },
      });
    }
  });
  await until(() => sink.read("inbox:sections") !== undefined, "the inbox");
  const away = ids40.find((id) => sink.read(`inbox:${id}`) === undefined);
  expect(away, "a settled thread outside the phone's window").toBeDefined();
  if (!away) return;

  const outcome = (await request({
    type: "inbox.bulk",
    action: "undoSettle",
    threadIds: [away],
  })) as BulkOutcome;
  expect(outcome.skipped).toEqual([]);
  expect(listed(daemon, away)?.settledAt).toBeUndefined();
});

test("taking back a settle restores the thread as it was: auto-settle stays and its snooze returns", async () => {
  const { daemon, sink, act, request } = await following((machine) => finished(machine, "a"));
  await until(() => ids(sink).length === 1, "the inbox");
  const until10 = 5_000_000 + 10 * 3_600_000;
  act({ kind: "snoozeAt", threadId: "a", until: until10 }, "snooze-a");
  await until(() => listed(daemon, "a")?.snoozedUntil === until10, "the snooze");
  await request({ type: "inbox.bulk", action: "settle", threadIds: ["a"] });
  expect(listed(daemon, "a")?.snoozedUntil).toBeUndefined();

  await request({ type: "inbox.bulk", action: "undoSettle", threadIds: ["a"] });
  act({ kind: "snoozeAt", threadId: "a", until: until10 }, "resnooze-a");
  await until(() => listed(daemon, "a")?.snoozedUntil === until10, "the snooze back");
  expect(listed(daemon, "a")?.settledAt).toBeUndefined();
  expect(listed(daemon, "a")?.autoSettle).not.toBe(false);
});

test("a project filter keeps other projects' archived threads out of search everything", async () => {
  const { daemon, sink, request } = await following((machine) => {
    finished(machine, "relay-here");
    finished(machine, "relay-elsewhere", "notes");
    machine.command({
      id: CommandId.parse("archive-elsewhere"),
      deviceId: DeviceId.parse("seed"),
      payload: { type: "thread.archive", threadId: ThreadId.parse("relay-elsewhere") },
    });
  });
  await until(() => ids(sink).length === 1, "the inbox");
  expect(listed(daemon, "relay-elsewhere")?.archivedAt).toBeDefined();
  type Answer = { threads: { id: string; workspaceId: string; listed: boolean }[] };
  const all = (await request({ type: "palette.query", query: "relay" })) as Answer;
  expect(all.threads.map((thread) => thread.id).toSorted()).toEqual([
    "relay-elsewhere",
    "relay-here",
  ]);
  expect(all.threads.find((thread) => !thread.listed)?.workspaceId).toBe("notes");
  const scoped = (await request({
    type: "palette.query",
    query: "relay",
    workspaceId: "ace",
  })) as Answer;
  expect(scoped.threads.map((thread) => thread.id)).toEqual(["relay-here"]);
});
