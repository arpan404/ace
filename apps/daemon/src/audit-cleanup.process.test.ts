import { stubHandler } from "./commands.ts";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { ThreadLifecycle } from "./thread-lifecycle.ts";
import { storeFixture } from "./long-thread-test-support.ts";
import { LongThreadDatabase } from "./long-thread/database.ts";

test("sixteen failing deletion rows cannot starve a later interrupted deletion", async () => {
  const f = storeFixture();
  const lifecycle = new ThreadLifecycle(
    { store: f.store, handler: stubHandler(), token: "0".repeat(64), hostId: "host", port: 0 },
    () => () => {},
  );
  for (let i = 0; i < 17; i++) {
    const id = ThreadId.parse(`delete-${String(i).padStart(2, "0")}`);
    f.store.appendEvents(id, [{ type: "thread.created", thread: { ...f.thread, id } }], 1000);
    const command = Command.parse({
      id: `command-${i}`,
      deviceId: "device",
      payload: { type: "thread.delete", threadId: id, force: true },
    });
    f.store.recordCommand(command.id, command.deviceId, () => ({
      commandId: command.id,
      ok: false,
      error: "client_action_pending",
    }));
    f.store.atomic((db) => {
      db.prepare("INSERT INTO thread_cleanup VALUES (?,?)").run(
        id,
        i < 16 ? "invalid cleanup" : JSON.stringify(command),
      );
      db.prepare("INSERT INTO thread_cleanup_members VALUES (?,?)").run(id, id);
    });
  }
  try {
    await lifecycle.start();
    expect(f.store.getThread(ThreadId.parse("delete-16"))?.deletedAt).toBeDefined();
    expect(f.store.getThread(ThreadId.parse("delete-00"))?.deletedAt).toBeUndefined();
  } finally {
    await lifecycle.close();
  }
});

test("statement eviction preserves SQL results and later canonical append", () => {
  const f = storeFixture();
  f.store.atomic((db) => {
    const data = new LongThreadDatabase(db);
    for (let i = 0; i < 160; i++)
      expect(data.sql(`SELECT ? AS value /* query ${i} */`).get(i)?.value).toBe(i);
    expect(data.sql("SELECT ? AS value /* query 0 */").get(999)?.value).toBe(999);
  });
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", title: "Still writable" }], 1000);
  expect(f.store.getThread(f.thread.id)?.title).toBe("Still writable");
});
