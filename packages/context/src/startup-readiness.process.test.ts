import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { UploadStore } from "./index.ts";

test("background recovery of legacy attachment accounting enforces existing global storage before admitting uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-context-ready-"));
  const options = {
    root,
    now: () => 0,
    id: () => "new-upload",
    authorize: () => true,
    limits: { globalBytes: 51200 },
  };
  const initial = await UploadStore.open(options);
  await initial.close();
  const db = new DatabaseSync(join(root, "context.sqlite"));
  db.exec("DROP TABLE storage; BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?,?)");
  for (let index = 0; index < 512; index++)
    insert.run(`pending-${index}`, "device", "thread", "a".repeat(64), 100, "old.txt", 0, 10000, 0);
  db.exec("COMMIT");
  db.close();
  const store = await UploadStore.open(options);
  try {
    let recovered = false;
    const recovery = store.ready.then(() => {
      recovered = true;
    });
    await Promise.resolve();
    expect(recovered).toBe(false);
    await expect(
      store.handle("device", {
        op: "upload.begin",
        threadId: "thread",
        bytes: 1,
        sha256: "b".repeat(64),
        name: "new.txt",
      }),
    ).rejects.toMatchObject({ code: "quota" });
    await recovery;
    expect(recovered).toBe(true);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
