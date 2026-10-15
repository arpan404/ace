import { DatabaseSync } from "node:sqlite";
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
      message: expect.stringMatching(/format 3.*reads format 4.*move that file aside/),
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
