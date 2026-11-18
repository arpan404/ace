import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { HomeData } from "@ace/protocol";
import { HOME_FORMAT_FILE, markerVersion } from "@ace/service/home";

/** One file's version: a number, absent (no such file), or there but unreadable. */
type Read = number | null | "unreadable";

/**
 * The data formats a home holds now (ADR 0177): its format marker, the event database's schema
 * version (its `schema_version` row), and the stored `user_version` of the notification and
 * Spade databases. The desktop app reads this from its daemon before it offers an older
 * release, which may switch only when it can read every one of them.
 *
 * Each database is opened read-only for one statement, so a running writer (Spade is its own
 * process) is never blocked, and a committed migration still in the WAL is counted. A file that
 * isn't there is null. One that is there but can't be read (locked, damaged, a timeout) is null
 * and named in `unreadable`, so the guard blocks rather than skips it.
 */
export function readHomeData(home: string): HomeData {
  const reads: Record<"home" | "daemon" | "notify" | "spade", Read> = {
    home: marker(home),
    daemon: stored(
      join(home, "events.sqlite"),
      "SELECT version AS v FROM schema_version WHERE id = 1",
    ),
    notify: stored(join(home, "notifications.sqlite"), "PRAGMA user_version"),
    spade: stored(join(home, "spade", "spade.sqlite"), "PRAGMA user_version"),
  };
  const number = (read: Read) => (typeof read === "number" ? read : null);
  const unreadable = Object.entries(reads).flatMap(([name, read]) =>
    read === "unreadable" ? [name] : [],
  );
  return {
    home: number(reads.home),
    daemon: number(reads.daemon),
    notify: number(reads.notify),
    spade: number(reads.spade),
    ...(unreadable.length ? { unreadable } : {}),
  };
}

function marker(home: string): Read {
  const path = join(home, HOME_FORMAT_FILE);
  if (!existsSync(path)) return null;
  try {
    return markerVersion(readFileSync(path, "utf8")) ?? "unreadable";
  } catch {
    return "unreadable";
  }
}

function stored(path: string, sql: string): Read {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 200 });
    const row: unknown = db.prepare(sql).get();
    if (typeof row !== "object" || row === null) return "unreadable";
    const value: unknown = Object.values(row)[0];
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : "unreadable";
  } catch {
    return "unreadable";
  } finally {
    db?.close();
  }
}
