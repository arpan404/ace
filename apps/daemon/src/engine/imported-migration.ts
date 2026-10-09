import type { Store } from "../store.ts";

/** Old imports with no live engine session are historical conversations, ready for Settled. */
export function settleLegacyImports(store: Store, at: number): void {
  store.atomic((db) => {
    db.exec("CREATE TABLE IF NOT EXISTS engine_data_upgrades (name TEXT PRIMARY KEY)");
    if (db.prepare("SELECT 1 FROM engine_data_upgrades WHERE name='settled-imports'").get()) return;
    for (const thread of store.listThreads()) {
      if (
        !thread.imported ||
        thread.settledAt !== undefined ||
        thread.deletedAt !== undefined ||
        db.prepare("SELECT 1 FROM engine_sessions WHERE thread_id=?").get(thread.id)
      )
        continue;
      store.appendEvents(
        thread.id,
        [
          { type: "thread.updated", status: { state: "done" } },
          {
            type: "thread.client.updated",
            changes: { settledAt: thread.updatedAt, settledReason: "manual", unread: false },
          },
        ],
        at,
      );
    }
    db.prepare("INSERT INTO engine_data_upgrades VALUES ('settled-imports')").run();
  });
}
