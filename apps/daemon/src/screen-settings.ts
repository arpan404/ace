import { z } from "zod";
import type { Store } from "./store.ts";

/** The person's computer use switch, kept across daemon restarts. Off until turned on. */
export class ScreenSettings {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS screen_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
        INSERT OR IGNORE INTO screen_settings VALUES (1,0);`),
    );
  }
  enabled(): boolean {
    const row = z
      .object({ enabled: z.number() })
      .parse(
        this.store.atomic((db) =>
          db.prepare("SELECT enabled FROM screen_settings WHERE id=1").get(),
        ),
      );
    return row.enabled === 1;
  }
  enable(enabled: boolean): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE screen_settings SET enabled=? WHERE id=1").run(enabled ? 1 : 0),
    );
  }
}
