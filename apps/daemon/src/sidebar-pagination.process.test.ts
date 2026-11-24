import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Thread, ThreadId, type ServerMessage, type WorkspaceId } from "@ace/protocol";
import { sidebarPage } from "@ace/projection";
import { fixture } from "./socket-test-support.ts";
import { subscribe, pageSubscription } from "./subscription.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function seeded() {
  const f = await fixture();
  cleanup.push(() => f.close());
  const workspace = f.thread.workspaceId;
  const entries = Array.from({ length: 55 }, (_, i) =>
    Thread.parse({
      id: `history-${String(i).padStart(3, "0")}`,
      workspaceId: workspace,
      title: `Task ${i}`,
      provider: "codex",
      status: { state: "done" },
      createdAt: 1,
      updatedAt: 1000 - i,
      activityAt: 1000 - i,
      settledAt: 2000,
      hasSentMessage: true,
    }),
  );
  for (const entry of entries)
    f.store.appendEvents(entry.id, [{ type: "thread.created", thread: entry }], entry.updatedAt);
  const active = Thread.parse({
    ...entries[0],
    id: "active",
    status: { state: "working", agents: 1 },
  });
  f.store.appendEvents(active.id, [{ type: "thread.created", thread: active }], 3000);
  const pinned = Thread.parse({ ...entries[0], id: "pinned", pinned: true });
  f.store.appendEvents(pinned.id, [{ type: "thread.created", thread: pinned }], 3000);
  return { ...f, entries, active, pinned };
}
test("initial actual payload contains all unsettled/pinned and only 20 settled, subsequent pages fetch 20", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "bounded",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    const snapshot = messages[0];
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "threads")
      throw new Error("Missing snapshot");
    expect(Object.keys(snapshot.view.threads)).toHaveLength(23);
    expect(snapshot.view.threads.active).toBeDefined();
    expect(snapshot.view.threads.pinned).toBeDefined();
    expect(snapshot.view.window?.total).toBe(55);
    expect(snapshot.view.window?.counts[0]?.threads).toBe(57);
    const before = snapshot.view.window?.before;
    if (!before) throw new Error("Missing cursor");
    pageSubscription(stop, before, "next");
    const page = messages.at(-1);
    if (page?.type !== "threads.patch") throw new Error("Missing page");
    expect(Object.keys(page.threads)).toHaveLength(20);
    const initialThreads = snapshot.view.threads;
    expect(Object.keys(page.threads).some((id) => Object.hasOwn(initialThreads, id))).toBe(false);
    expect(page.requestId).toBe("next");
    expect(page.window.before).not.toBeNull();
    if (!page.window.before) throw new Error("Missing last page cursor");
    pageSubscription(stop, page.window.before, "last");
    const last = messages.at(-1);
    if (last?.type !== "threads.patch") throw new Error("Missing last page");
    expect(Object.keys(last.threads)).toHaveLength(15);
    expect(last.window.before).toBeNull();
  } finally {
    stop();
  }
});
test("unseen old settled threads enter live on unsettle and archive removes them without downloading history", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "live",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    const id = f.entries[54]!.id;
    f.store.appendEvents(
      id,
      [{ type: "thread.client.updated", changes: { settledAt: null } }],
      5000,
    );
    const change = messages.at(-1);
    if (change?.type !== "threads.patch") throw new Error("Missing change");
    expect(change.threads[id]?.settledAt).toBeUndefined();
    expect(change.window.total).toBe(54);
    f.store.appendEvents(id, [{ type: "thread.updated", archivedAt: 5001 }], 5001);
    const archived = messages.at(-1);
    if (archived?.type !== "threads.patch") throw new Error("Missing archive");
    expect(archived.removed).toContain(id);
    expect(archived.window.counts[0]?.threads).toBe(56);
  } finally {
    stop();
  }
});
test("SQL classification and ordering match shared pagination for filters, pins, drafts and queue attention", async () => {
  const f = await seeded();
  const id = f.entries[53]!.id;
  const original = f.store.getThread(id)!;
  f.store.appendEvents(
    id,
    [
      {
        type: "queue.updated",
        revision: 1,
        pendingCount: 1,
        paused: true,
        reason: "manual",
        resumeAt: null,
      },
    ],
    5000,
  );
  expect(f.store.getThread(id)?.queue).toBeDefined();
  for (const options of [
    { limit: 20 },
    { limit: 20, project: original.workspaceId },
    { limit: 20, project: "missing" },
    { limit: 20, archived: true },
  ]) {
    const expected = sidebarPage(f.store.listThreads(), options);
    const actual = f.store.sidebarPage(options);
    expect(actual.threads.map((entry) => entry.id)).toEqual(
      expected.threads.map((entry) => entry.id),
    );
    // The daemon adds the row revision the window reflects (for resume); the rest is shared.
    expect(actual.window).toEqual({ ...expected.window, revision: expect.any(Number) });
  }
});

function settledOrLive(
  id: ThreadId,
  workspaceId: WorkspaceId,
  activityAt: number,
  settled: boolean,
) {
  return Thread.parse({
    id,
    workspaceId,
    title: id,
    provider: "codex",
    status: settled ? { state: "done" } : { state: "working", agents: 1 },
    createdAt: 1,
    updatedAt: activityAt,
    activityAt,
    ...(settled ? { settledAt: 5000 } : {}),
    hasSentMessage: true,
  });
}
/** A hidden chat project in `f`'s home, as `workspace.chat.create` registers one (ADR 0099). */
function chatProject(f: Awaited<ReturnType<typeof seeded>>, name: string) {
  const id = f.store.createWorkspace(join(f.home, name), name);
  f.store.atomic((db) =>
    db
      .prepare(
        "INSERT INTO workspace_metadata(workspace_id,kind) VALUES (?,'chat') ON CONFLICT(workspace_id) DO UPDATE SET kind='chat'",
      )
      .run(id),
  );
  return id;
}
test("a project's paged window carries every chat, and paging reaches each exactly once", async () => {
  const f = await seeded();
  const chats = [chatProject(f, "chat-one"), chatProject(f, "chat-two")];
  const other = f.store.createWorkspace(join(f.home, "other"), "Other");
  const add = (id: string, workspaceId: WorkspaceId, activityAt: number, settled: boolean) => {
    const threadId = ThreadId.parse(id);
    const next = settledOrLive(threadId, workspaceId, activityAt, settled);
    f.store.appendEvents(threadId, [{ type: "thread.created", thread: next }], activityAt);
  };
  // Interleaved with the project's own history, so a window must merge the two.
  const chatPaged = ["chat-1", "chat-2", "chat-3", "chat-4", "chat-5"];
  chatPaged.forEach((id, index) => add(id, chats[index % 2]!, 995 - index * 10, true));
  const chatLive = "chat-live";
  add(chatLive, chats[0]!, 4000, false);
  const others = ["other-1", "other-2"];
  others.forEach((id, index) => add(id, other, 3000 + index, true));

  // The client's own window: a project's page carries every chat.
  const options = { limit: 7, project: f.workspace as string, withChats: true };
  const live = f.store.sidebarPage(options, undefined, { entries: new Map(), changed: new Set() });
  const first = f.store.sidebarPage(options);
  expect(live.threads.map((entry) => entry.id)).toEqual(first.threads.map((entry) => entry.id));
  expect(live.window.total).toBe(first.window.total);
  // The seeded project's 55 settled threads, plus the chats' five.
  expect(first.window.total).toBe(60);
  expect(first.threads.some((entry) => chatPaged.includes(entry.id))).toBe(true);

  const seen = new Map<string, number>();
  let page = first;
  let before = page.window.before;
  const cursors = new Set<string>();
  const collect = () => {
    for (const entry of page.threads) seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
  };
  collect();
  while (before) {
    const cursor = `${before.at}:${before.id}`;
    if (!cursors.add(cursor) || cursors.size > 100)
      throw new Error(`Paging does not reach the end: ${cursor}`);
    page = f.store.sidebarPage(options, before);
    collect();
    before = page.window.before;
  }
  expect([...seen.keys()].toSorted()).toEqual(
    [
      ...f.entries.map((entry) => entry.id),
      f.thread.id,
      f.active.id,
      f.pinned.id,
      ...chatPaged,
      chatLive,
    ].toSorted(),
  );
  expect([...seen.values()].filter((count) => count !== 1)).toEqual([]);
  expect(others.filter((id) => seen.has(id))).toEqual([]);

  // A chat newer than the cursor stays behind it; an older one comes back once, in order,
  // ahead of the project thread sharing its moment (ids ascend on a tie).
  const across = f.store.sidebarPage(options, { at: 976, id: ThreadId.parse("history-024") });
  expect(across.threads.map((entry) => entry.id)).toEqual([
    "chat-3",
    "history-025",
    "history-026",
    "history-027",
    "history-028",
    "history-029",
    "history-030",
  ]);
});

test("a chat's own project pages each of its threads once", async () => {
  const f = await seeded();
  const chat = chatProject(f, "chat-own");
  const ids = ["own-1", "own-2", "own-3"];
  ids.forEach((id, index) => {
    const threadId = ThreadId.parse(id);
    f.store.appendEvents(
      threadId,
      [{ type: "thread.created", thread: settledOrLive(threadId, chat, 4000 + index, true) }],
      4000 + index,
    );
  });
  const options = { limit: 2, project: chat as string, withChats: true };
  const seen: string[] = [];
  let page = f.store.sidebarPage(options);
  expect(page.window.total).toBe(3);
  seen.push(...page.threads.map((entry) => entry.id));
  let before = page.window.before;
  for (let pages = 0; before; pages++) {
    if (pages > 10) throw new Error("Paging does not reach the end");
    page = f.store.sidebarPage(options, before);
    seen.push(...page.threads.map((entry) => entry.id));
    before = page.window.before;
  }
  expect(seen).toEqual(["own-3", "own-2", "own-1"]);
});

test("a resumed project window keeps unchanged threads instead of resending them", async () => {
  const f = await seeded();
  const chat = chatProject(f, "chat-resume");
  const chatThread = ThreadId.parse("chat-resume-thread");
  f.store.appendEvents(
    chatThread,
    [{ type: "thread.created", thread: settledOrLive(chatThread, chat, 4500, true) }],
    4500,
  );
  const window = { limit: 10, project: f.workspace as string };
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "resume-one",
    { kind: "threads", window },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    const snapshot = messages[0];
    if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "threads")
      throw new Error("Missing snapshot");
    const held = Object.keys(snapshot.view.threads);
    expect(held).toContain(chatThread);
    const resume = {
      revision: snapshot.view.window?.revision ?? 0,
      epoch: snapshot.view.window?.epoch ?? "",
    };
    stop();
    // Nothing changed while it was away: the resumed list keeps every thread it held and is
    // sent none of them again (a projection missing the revisions would resend them all).
    const again: ServerMessage[] = [];
    const resumed = subscribe(
      f.store,
      "resume-two",
      { kind: "threads", window: { ...window, resume } },
      undefined,
      5000,
      (message) => again.push(message),
    );
    try {
      const next = again[0];
      if (next?.type !== "snapshot" || next.view.kind !== "threads")
        throw new Error("Missing resumed snapshot");
      expect(next.view.keep?.toSorted()).toEqual(held.toSorted());
      expect(Object.keys(next.view.threads)).toEqual([]);
    } finally {
      resumed();
    }
  } finally {
    stop();
  }
});

test("a settled thread that comes to need the person is listed with the work in hand, not paged as settled", async () => {
  const f = await seeded();
  const base = f.entries[0]!;
  const settledAs = (id: string, patch: Record<string, unknown>) => {
    const thread = Thread.parse({ ...base, id, activityAt: 5, updatedAt: 5, ...patch });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }], 5);
  };
  // Oldest of all: paged last if it were settled, so only the rule can bring it into view.
  settledAs("asks", { status: { state: "needs_you", interactions: 1 }, settledReason: "manual" });
  settledAs("failed", { status: { state: "failed" }, settledReason: "manual" });
  const options = { limit: 20 };
  const page = f.store.sidebarPage(options);
  const ids = page.threads.map((entry) => entry.id);
  expect(ids).toContain("asks");
  expect(ids).not.toContain("failed");
  // 55 settled histories and the settled failure; the question is not counted as settled.
  expect(page.window.total).toBe(56);
  const shared = sidebarPage(f.store.listThreads(), options);
  expect(ids).toEqual(shared.threads.map((entry) => entry.id));
  expect(page.window).toEqual({ ...shared.window, revision: expect.any(Number) });
});

test("settling active work prunes the older edge of the loaded window and stable cursors do not repeat ties", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "prune",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    f.store.appendEvents(
      f.active.id,
      [
        { type: "thread.updated", status: { state: "done" } },
        { type: "thread.client.updated", changes: { settledAt: 6000, activityAt: 6000 } },
      ],
      6000,
    );
    const update = messages.at(-1);
    if (update?.type !== "threads.patch") throw new Error("Missing live patch");
    expect(update.threads.active?.settledAt).toBe(6000);
    expect(update.removed).toContain(f.entries[19]!.id);
    expect(update.window.total).toBe(56);
    const before = update.window.before;
    if (!before) throw new Error("Missing page cursor");
    pageSubscription(stop, before, "stable");
    const page = messages.at(-1);
    if (page?.type !== "threads.patch") throw new Error("Missing page");
    expect(Object.keys(page.threads)).toHaveLength(20);
    expect(Object.keys(page.threads)).toContain(f.entries[19]!.id);
  } finally {
    stop();
  }
});

test("deeply paged live windows refresh changed history and remove deleted entries", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "deep",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    for (;;) {
      const last = messages.at(-1);
      const window =
        last?.type === "snapshot" && last.view.kind === "threads"
          ? last.view.window
          : last?.type === "threads.patch"
            ? last.window
            : undefined;
      if (!window?.before) break;
      pageSubscription(stop, window.before, "more");
    }
    const target = f.entries.at(-1);
    if (!target) throw new Error("Missing history");
    f.store.appendEvents(
      target.id,
      [{ type: "thread.updated", title: "Changed deep history" }],
      6000,
    );
    const update = messages.at(-1);
    if (update?.type !== "threads.patch") throw new Error("Missing update");
    expect(Object.keys(update.threads)).toEqual([target.id]);
    expect(update.threads[target.id]?.title).toBe("Changed deep history");
    expect(update.window.total).toBe(55);
    f.store.appendEvents(
      target.id,
      [{ type: "thread.client.updated", changes: { deletedAt: 6001 } }],
      6001,
    );
    const removal = messages.at(-1);
    if (removal?.type !== "threads.patch") throw new Error("Missing removal");
    expect(removal.removed).toContain(target.id);
    expect(removal.window.total).toBe(54);
  } finally {
    stop();
  }
});

test("quiet SQL changes become visible on the next unrelated sidebar event", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "sql",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    const quiet = f.entries[0];
    if (!quiet) throw new Error("Missing quiet thread");
    f.store.atomic((db) =>
      db.prepare("UPDATE threads SET title=? WHERE id=?").run("Quiet update", quiet.id),
    );
    f.store.appendEvents(f.active.id, [{ type: "thread.updated", title: "Unrelated" }], 6000);
    const update = messages.at(-1);
    if (update?.type !== "threads.patch") throw new Error("Missing update");
    expect(update.threads[quiet.id]?.title).toBe("Quiet update");
    expect(
      f.store.sidebarPage({ limit: 20 }).threads.find((entry) => entry.id === quiet.id)?.title,
    ).toBe("Quiet update");
  } finally {
    stop();
  }
});

test("a quietly replaced row cannot reuse its deleted predecessor's payload", async () => {
  const f = await seeded();
  const messages: ServerMessage[] = [];
  const stop = subscribe(
    f.store,
    "replace",
    { kind: "threads", window: { limit: 20 } },
    undefined,
    5000,
    (message) => messages.push(message),
  );
  try {
    const quiet = f.entries[0];
    if (!quiet) throw new Error("Missing quiet thread");
    f.store.atomic((db) => {
      db.exec("CREATE TEMP TABLE replaced_sidebar_row AS SELECT * FROM threads WHERE 0");
      db.prepare("INSERT INTO replaced_sidebar_row SELECT * FROM threads WHERE id=?").run(quiet.id);
      db.prepare("DELETE FROM threads WHERE id=?").run(quiet.id);
      db.exec(
        "UPDATE replaced_sidebar_row SET title='Recreated'; INSERT INTO threads SELECT * FROM replaced_sidebar_row; DROP TABLE replaced_sidebar_row;",
      );
    });
    f.store.appendEvents(f.active.id, [{ type: "thread.updated", title: "Unrelated" }], 6000);
    const update = messages.at(-1);
    if (update?.type !== "threads.patch") throw new Error("Missing update");
    expect(update.threads[quiet.id]?.title).toBe("Recreated");
  } finally {
    stop();
  }
});
