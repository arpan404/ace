import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { HomeData } from "@ace/protocol";
import { HOME_FORMAT_FILE, markerVersion } from "@ace/service/home";

/**
 * The data formats a home holds now (ADR 0174): its format marker, the event database's schema
 * version (its `schema_version` row), and the stored `user_version` of the notification and
 * Spade databases. The desktop app reads this from its daemon before it offers an older
 * release, which may switch only when it can read every one of them.
 *
 * Each database is opened read-only for one statement, so a running writer (Spade is its own
 * process) is never blocked, and a committed migration still in the WAL is counted. A file that
 * isn't there, or can't be read, is null.
 */
export function readHomeData(home: string): HomeData {
  return {
    home: marker(home),
    daemon: stored(join(home, "events.sqlite"), "SELECT version AS v FROM schema_version WHERE id = 1"),
    notify: stored(join(home, "notifications.sqlite"), "PRAGMA user_version"),
    spade: stored(join(home, "spade", "spade.sqlite"), "PRAGMA user_version"),
  };
}

function marker(home: string): number | null {
  try {
    return markerVersion(readFileSync(join(home, HOME_FORMAT_FILE), "utf8")) ?? null;
  } catch {
    return null;
  }
}

function stored(path: string, sql: string): number | null {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 200 });
    const row: unknown = db.prepare(sql).get();
    if (typeof row !== "object" || row === null) return null;
    const value: unknown = Object.values(row)[0];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
