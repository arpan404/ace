import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import { expect, it } from "vitest";
import { setup } from "./notify.test-helper.ts";

it("a notification database in an older format is refused with its path and recovery, rows untouched", async () => {
  const f = setup();
  try {
    f.start();
    f.end();
    await f.flush();
    expect(f.deliveries.length).toBeGreaterThan(0);
    await f.service.close();
    const older = new DatabaseSync(f.path);
    older.exec("PRAGMA user_version=3");
    const rows = older.prepare("SELECT count(*) AS n FROM threads").get()?.n;
    older.close();
    await expect(f.reopen()).rejects.toMatchObject({
      code: "incompatible-data",
      path: f.path,
      message: expect.stringMatching(/format 3.*reads format 5.*move that file aside/),
    });
    const after = new DatabaseSync(f.path, { readOnly: true });
    expect(after.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(after.prepare("SELECT count(*) AS n FROM threads").get()?.n).toBe(rows);
    after.close();
  } finally {
    await f.close().catch(() => undefined);
  }
});

it("a fresh notification database keeps its cursor and keeps delivering after reopening", async () => {
  const f = setup();
  try {
    f.start();
    f.end();
    await f.flush();
    const cursor = f.service.cursor();
    const delivered = f.deliveries.length;
    expect(cursor).toBeGreaterThan(0);
    await f.reopen();
    expect(f.service.cursor()).toBe(cursor);
    f.start();
    f.end();
    await f.flush();
    expect(f.deliveries.length).toBeGreaterThan(delivered);
  } finally {
    await f.close();
  }
});

it("a format 4 database opens as format 5 with its rows, and the daemon's records mark its paired machines' children", async () => {
  const f = setup("retry");
  try {
    f.start();
    f.end();
    await f.flush();
    expect(f.deliveries).toHaveLength(2);
    await f.service.close();
    const older = new DatabaseSync(f.path);
    older.exec("PRAGMA user_version=4");
    older.close();

    await f.reopen();
    const upgraded = new DatabaseSync(f.path, { readOnly: true });
    expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(5);
    upgraded.close();
    // The store never saw the event saying so; the daemon's delegation records mark the thread.
    f.service.markRemote([f.threadId]);
    f.setOutcome("accepted");
    f.setTime(600_000);
    await f.service.drain();
    expect(f.deliveries).toHaveLength(2);
    f.start();
    f.end();
    await f.flush();
    expect(f.deliveries).toHaveLength(2);
    // A thread the records don't name keeps alerting.
    const local = ThreadId.parse("local");
    f.append(
      [
        {
          type: "thread.created",
          thread: {
            id: local,
            workspaceId: WorkspaceId.parse("workspace"),
            title: "Local",
            provider: "codex",
            status: { state: "new" },
            createdAt: 600_000,
            updatedAt: 600_000,
          },
        },
        { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
      ],
      local,
    );
    await f.flush();
    expect(f.deliveries.slice(2).map((d) => d.notification.threadId)).toEqual([local, local]);
  } finally {
    await f.close().catch(() => undefined);
  }
});
