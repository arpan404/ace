import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Thread, type EventPayload } from "@ace/protocol";
import { expect, it } from "vitest";
import { Store } from "./store.ts";
import { shell } from "./payload-test-support.ts";

it("upgrades an existing log into paged items, streamed output and capped raw data without changing cursors", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-upgrade-"));
  const path = join(home, "events.sqlite");
  const db = new DatabaseSync(path);
  // A database produced by schema version 1, before payload tables existed.
  db.exec(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (1, 1);
    CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, thread_id TEXT, at INTEGER, type TEXT, payload JSON);
    CREATE INDEX events_thread_seq ON events(thread_id, seq);
    CREATE TABLE threads (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, provider TEXT, status JSON, created_at INTEGER, updated_at INTEGER, archived_at INTEGER, root_agent_id TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT UNIQUE, name TEXT, created_at INTEGER);
    CREATE TABLE command_receipts (command_id TEXT PRIMARY KEY, device_id TEXT, received_at INTEGER, result JSON);
    INSERT INTO workspaces VALUES ('w', '/repo', 'Repo', 1);`);
  const thread = Thread.parse({
    id: "t",
    workspaceId: "w",
    title: "Existing",
    provider: "codex",
    status: { state: "done" },
    createdAt: 1,
    updatedAt: 1,
  });
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)").run(
    thread.id,
    thread.workspaceId,
    thread.title,
    thread.provider,
    JSON.stringify(thread.status),
    1,
    1,
  );
  const item = shell();
  if (item.type !== "tool_call") throw new Error("Expected shell");
  const created = {
    ...item,
    call: {
      ...item.call,
      detail: { kind: "shell", command: "echo", output: "initial", outputTruncated: false },
    },
  };
  const updated = {
    ...created,
    complete: true,
    call: {
      ...created.call,
      status: "succeeded",
      raw: [{ type: "native", data: "r".repeat(100000) }],
      detail: { ...created.call.detail, output: "initial delta" },
    },
  };
  const payloads: unknown[] = [
    { type: "thread.created", thread },
    { type: "item.created", item: created },
    {
      type: "item.delta",
      itemId: item.id,
      agentId: item.agentId,
      field: "output",
      append: " delta",
    } satisfies EventPayload,
    { type: "item.updated", item: updated },
  ];
  payloads.forEach((payload, i) =>
    db
      .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        i + 1,
        `e${i + 1}`,
        thread.id,
        1,
        (payload as { type: string }).type,
        JSON.stringify(payload),
      ),
  );
  db.close();
  let store: Store | undefined;
  try {
    store = new Store(path);
    expect(store.headSeq()).toBe(4);
    expect(
      store.readEvents({ afterSeq: 0, limit: 10 }).map((event) => [event.seq, event.id]),
    ).toEqual([
      [1, "e1"],
      [2, "e2"],
      [3, "e3"],
      [4, "e4"],
    ]);
    const view = store.snapshotThread(thread.id);
    expect(view.itemOrder).toEqual([item.id]);
    expect(view.items.shell).toMatchObject({
      complete: true,
      call: {
        detail: { output: { bytes: 13, tail: "initial delta", truncated: false } },
        raw: [{ blobRef: expect.any(String), size: 100002 }],
      },
    });
    expect(Buffer.from(store.readOutput("output:shell", 0, 100).bytes, "base64").toString()).toBe(
      "initial delta",
    );
    store.close();
    store = new Store(path);
    expect(store.snapshotThread(thread.id)).toEqual(view);
    expect(Buffer.from(store.readOutput("output:shell", 0, 100).bytes, "base64").toString()).toBe(
      "initial delta",
    );
    expect(
      store.appendEvents(thread.id, [{ type: "thread.updated", title: "After upgrade" }])[0]?.seq,
    ).toBe(5);
  } finally {
    store?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
