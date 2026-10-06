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
  // Restore the pre-MIME schema and pre-storage-counter state of a legacy database.
  db.exec("ALTER TABLE uploads DROP COLUMN mime_type; DROP TABLE storage; BEGIN IMMEDIATE");
  const insert = db.prepare(
    "INSERT INTO uploads(id,device,thread,sha256,bytes,name,offset,expires,done) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  const usage = db.prepare("INSERT INTO usage VALUES(?,?,?)");
  for (let index = 0; index < 512; index++) {
    const thread = `thread-${index}`;
    insert.run(`pending-${index}`, "device", thread, "a".repeat(64), 100, "old.txt", 0, 10000, 0);
    usage.run(thread, 100, 1);
  }
  db.exec("UPDATE usage SET bytes=51200,count=512 WHERE scope='*'");
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
    expect(
      await store.handle("device", { op: "upload.status", uploadId: "pending-0" }),
    ).toMatchObject({ kind: "upload", offset: 0, bytes: 100 });
    await store.handle("device", { op: "upload.cancel", uploadId: "pending-0" });
    expect(
      await store.handle("device", {
        op: "upload.begin",
        threadId: "thread",
        bytes: 1,
        sha256: "b".repeat(64),
        name: "new.txt",
      }),
    ).toMatchObject({ kind: "upload", offset: 0, bytes: 1 });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
