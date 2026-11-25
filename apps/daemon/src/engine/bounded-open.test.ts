import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, ThreadId, type CommandPayload } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { createThreadState } from "@ace/core";
import { Store, createDevThread } from "@ace/daemon";
import { EngineRepository } from "./repository.ts";
import { InputOrphansFill } from "./input-journal.ts";
import { cursorDefaultInstanceId } from "@ace/provider-kit/cursor-selection";
import { canonicalRoot } from "../workspace-reservations.ts";

/**
 * Opening a home does only schema setup (ADR 0170): the data passes that used to run there are
 * bounded idle fills, and every reader is correct before a fill completes.
 */

const opened: { close(): void }[] = [];
afterEach(() => {
  while (opened.length) opened.pop()?.close();
});

function open() {
  const home = mkdtempSync(join(tmpdir(), "ace-bounded-open-"));
  const store = new Store(join(home, "events.sqlite"));
  const repo = new EngineRepository(store, undefined, 64, undefined, undefined, () => 1_000);
  opened.push({
    close: () => {
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  });
  const workspace = store.createWorkspace(home, "Workspace");
  const thread = createDevThread(store, workspace);
  return { home, store, repo, thread, workspace };
}

/** A store whose statements report the arguments of an `engine_inputs` page read. */
function statementSpy(store: Store, reads: unknown[][]): Store {
  const wrap = (db: import("node:sqlite").DatabaseSync) =>
    ({
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes("FROM engine_inputs")) return statement;
        return {
          all: (...args: import("node:sqlite").SQLInputValue[]) => {
            reads.push(args);
            return statement.all(...args);
          },
          get: (...args: import("node:sqlite").SQLInputValue[]) => statement.get(...args),
          run: (...args: import("node:sqlite").SQLInputValue[]) => statement.run(...args),
          iterate: (...args: import("node:sqlite").SQLInputValue[]) => statement.iterate(...args),
        };
      },
    }) as unknown as import("node:sqlite").DatabaseSync;
  return {
    atomic: (run: (db: import("node:sqlite").DatabaseSync) => unknown, outcome?: object) =>
      store.atomic((db) => run(wrap(db)), outcome as Parameters<typeof store.atomic>[1]),
    statement: (sql: string) => store.statement(sql),
  } as unknown as Store;
}

function openCursor() {
  return openWithProvider("cursor");
}

function openWithProvider(provider: "codex" | "cursor") {
  const home = mkdtempSync(join(tmpdir(), "ace-bounded-open-"));
  const store = new Store(join(home, "events.sqlite"));
  const repo = new EngineRepository(store, undefined, 64, undefined, undefined, () => 1_000);
  opened.push({
    close: () => {
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  });
  const workspace = store.createWorkspace(home, "Workspace");
  const thread = createDevThread(store, workspace, "Thread", provider);
  return { home, store, repo, thread, workspace };
}

function send(id: ThreadId, text: string): Command {
  return Command.parse({
    id: `cmd-${text}`,
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text }],
    } satisfies CommandPayload,
  });
}

test("a thread with a pending send and no queue row shows that send in its queue snapshot and page", () => {
  const { store, repo, thread } = open();
  repo.add(send(thread.id, "first"), thread.id);

  const snapshot = repo.queue.snapshot(thread.id);
  expect(snapshot.pendingCount).toBe(1);
  expect(snapshot.messages.map((message) => message.id)).toEqual(["cmd-first"]);
  expect(snapshot.paused).toBe(false);
  expect(snapshot.revision).toBe(0);

  const page = repo.queue.page({ threadId: thread.id });
  expect(page.messages.map((message) => message.id)).toEqual(["cmd-first"]);
  expect(page.total).toBe(1);

  // Reading the whole queue row too: defaults for the metadata, real pending work.
  const record = repo.queue.get(thread.id);
  expect(record.pendingCount).toBe(1);
  expect(record.holdToken).toBe(0);
  expect(record.exited).toBe(false);
  expect(store.atomic((db) => db.prepare("SELECT 1 FROM engine_queue").get())).toBeUndefined();
});

test("a thread whose queue row was never created still runs its pending send", () => {
  const { repo, thread } = open();
  repo.add(send(thread.id, "first"), thread.id);

  expect(repo.pending.runnableThreads(10)).toContain(thread.id);
});

test("a send queued on a thread with no queue row takes the defaults when it is set", () => {
  const { store, repo, thread } = open();
  const command = send(thread.id, "first");
  repo.add(command, thread.id);

  repo.queue.set(thread.id, { paused: true, reason: "manual" }, 1_000);

  const counted = repo.queue.count(thread.id);
  expect(counted).toBe(1);
  expect(repo.queue.get(thread.id).paused).toBe(true);
  expect(
    store.atomic((db) => db.prepare("SELECT thread_id FROM engine_queue").get()?.thread_id),
  ).toBe(thread.id);
});

test("the queue rows fill creates the row for a thread that has engine state", () => {
  const { store, repo, thread } = open();
  repo.save(
    createThreadState({ threadId: thread.id, config: { provider: "codex", silenceMs: 100 } }),
    [],
    1_000,
  );
  expect(store.atomic((db) => db.prepare("SELECT 1 FROM engine_queue").get())).toBeUndefined();

  while (!repo.fills.complete("queue-rows")) repo.fills.pump();

  expect(
    store.atomic((db) => db.prepare("SELECT thread_id FROM engine_queue").get()?.thread_id),
  ).toBe(thread.id);
});

test("an attachment a live intent needs reads as retained before the attachment fill completes", () => {
  const { store, repo, thread } = open();
  const hash = "a".repeat(64);
  const command = Command.parse({
    id: "cmd-attachment",
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: thread.id,
      input: [{ type: "text", text: "look" }],
      context: {
        attachments: [{ sha256: hash, bytes: 12, mimeType: "text/plain", name: "notes.txt" }],
      },
    },
  });
  repo.add(command, thread.id);
  // An intent that predates the writer that tracks attachments.
  store.atomic((db) => db.prepare("DELETE FROM engine_queue_attachments").run());

  expect(repo.fills.complete("queue-attachments")).toBe(false);
  expect(repo.queue.retains(thread.id, hash)).toBe(true);
  expect(repo.queue.retains(thread.id, "b".repeat(64))).toBe(false);

  while (!repo.fills.complete("queue-attachments")) repo.fills.pump();
  expect(repo.queue.retains(thread.id, hash)).toBe(true);
  expect(
    store.atomic((db) => db.prepare("SELECT COUNT(*) AS n FROM engine_queue_attachments").get()?.n),
  ).toBe(1);
});

test("a Cursor thread opened before the migration fill reaches it opens on the SDK backend", () => {
  const { store, repo, thread } = openCursor();
  repo.save(
    createThreadState({ threadId: thread.id, config: { provider: "cursor", silenceMs: 100 } }),
    [],
    1_000,
  );
  repo.createSession(thread.id, "/tmp");
  expect(repo.fills.complete("cursor-empty")).toBe(false);

  // Both reads a launch makes — the engine's backend and the session binding it opens with —
  // answer for the migration before the fill has visited the thread.
  expect(repo.backend(thread.id)).toBe("cursor-sdk");
  expect(repo.session(thread.id)).toMatchObject({
    backend: "cursor-sdk",
    instanceId: cursorDefaultInstanceId,
  });
  expect(
    store.atomic(
      (db) =>
        db.prepare("SELECT backend FROM engine_sessions WHERE thread_id=?").get(thread.id)?.backend,
    ),
  ).toBe("cursor-sdk");
});

test("the Cursor fill publishes the migration it commits", () => {
  const { store, repo, thread } = openCursor();
  repo.save(
    createThreadState({ threadId: thread.id, config: { provider: "cursor", silenceMs: 100 } }),
    [],
    1_000,
  );
  repo.createSession(thread.id, "/tmp");
  const seen: { threadId: string; backend?: string }[] = [];
  const stop = store.subscribe((events) => {
    for (const event of events)
      if (event.payload.type === "thread.updated" && event.payload.backend)
        seen.push({ threadId: event.threadId, backend: event.payload.backend });
  });
  try {
    while (!repo.fills.complete("cursor-empty")) repo.fills.pump();
  } finally {
    stop();
  }
  // The fill's step commits under an outcome; its event must still reach subscribers.
  expect(seen).toContainEqual({ threadId: thread.id, backend: "cursor-sdk" });
});

test("orphaned input rows are gone once the fill completes, and a stop mid-fill resumes from its cursor", () => {
  const { store, workspace } = open();
  const live = createDevThread(store, workspace).id;
  const gone = ThreadId.parse("22222222-2222-4222-8222-222222222222");
  store.atomic((db) => {
    const insert = db.prepare(
      "INSERT INTO engine_inputs(thread_id,item_key,signature,origin) VALUES (?,?,?,?)",
    );
    insert.run(live, "input:live", "sig", '{"kind":"person","commandId":"live"}');
    for (let index = 0; index < 300; index++)
      insert.run(gone, `input:${index}`, "sig", '{"kind":"person","commandId":"orphan"}');
  });

  // One step removes a bounded page, then the saved cursor is where a restart resumes.
  const first = new InputOrphansFill(store);
  first.step();
  expect(
    store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM engine_inputs WHERE thread_id=?").get(gone)?.n,
    ),
  ).toBe(45);
  // The restart reads the saved cursor, never the first page again.
  const readFrom: unknown[][] = [];
  const resumed = new InputOrphansFill(statementSpy(store, readFrom));
  while (!resumed.complete()) resumed.step();
  expect(readFrom[0]?.[0]).toBe(256);
  expect(
    store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM engine_inputs WHERE thread_id=?").get(gone)?.n,
    ),
  ).toBe(0);
  expect(
    store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM engine_inputs WHERE thread_id=?").get(live)?.n,
    ),
  ).toBe(1);
});

test("the session roots fill canonicalizes a stored alias, and a reservation matches it meanwhile", () => {
  const { store, repo, thread, home } = open();
  const alias = join(home, "alias");
  symlinkSync(home, alias, "dir");
  repo.createSession(thread.id, alias);
  const canonical = canonicalRoot(home);
  expect(canonicalRoot(alias)).toBe(canonical);
  // Before the fill rewrites the row, a fence on the canonical root still sees the thread.
  store.workspaceReservations.reserve(thread.id, "move", [canonical]);
  expect(store.workspaceReservations.threadReserved(thread.id)).toBe(true);

  while (!repo.fills.complete("session-roots")) repo.fills.pump();
  expect(repo.session(thread.id).cwd).toBe(canonical);
});
