import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomeRow } from "./home-rows.ts";

/**
 * The home's last list, kept so the next `ace` draws rows before the daemon answers (ADR 0176
 * §9, the 150 ms budget). It keeps what a row is (title, project, branch, provider) and never
 * what it was doing: a kept row claims no status and says "Syncing", as the app's unconfirmed
 * rows do, until the live list replaces it. So a stale copy can never show a thread as done
 * while it works or waits on the person. Small (the first `keptRows` rows) and local: a file
 * beside the CLI's outbox in the ace home, readable only by the person.
 */
export const keptRows = 40;

/** The word a kept row shows in place of its status (the app's `syncingWord`). */
export const unconfirmedWord = "Syncing";

const fileName = "cli-home-rows.json";

interface KeptRow {
  readonly id: string;
  readonly project: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch: string;
  readonly provider: string;
}

export function homeCachePath(home: string): string {
  return join(home, fileName);
}

/** The record to keep for `rows`, in their order. Pure. */
export function keptRecord(rows: readonly HomeRow[]): string {
  const kept: KeptRow[] = rows.slice(0, keptRows).map((row) => ({
    id: row.id,
    project: row.project,
    projectId: row.projectId,
    title: row.title,
    branch: row.branch,
    provider: row.provider,
  }));
  return JSON.stringify({ version: 1, rows: kept });
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Rows from a kept record, every one unconfirmed: no glyph, no time but "Syncing", nothing
 * running and nothing that needs the person. A record this build can't read gives none. Pure.
 */
export function rowsFromRecord(record: string): HomeRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  if (Reflect.get(parsed, "version") !== 1) return [];
  const rows: unknown = Reflect.get(parsed, "rows");
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, keptRows).flatMap((raw: unknown): HomeRow[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const id = text(Reflect.get(raw, "id"));
    const title = text(Reflect.get(raw, "title"));
    if (!id || title === undefined) return [];
    return [
      {
        id,
        glyph: " ",
        tone: "idle",
        state: "syncing",
        time: unconfirmedWord,
        meaning: unconfirmedWord,
        project: text(Reflect.get(raw, "project")) ?? "",
        projectId: text(Reflect.get(raw, "projectId")) ?? "",
        title,
        branch: text(Reflect.get(raw, "branch")) ?? "",
        provider: text(Reflect.get(raw, "provider")) ?? "",
        needsYou: false,
        running: false,
      },
    ];
  });
}

/** The kept rows, or none when there is no record (a first run) or it can't be read. */
export function readKeptRows(home: string): HomeRow[] {
  try {
    return rowsFromRecord(readFileSync(homeCachePath(home), "utf8"));
  } catch {
    return [];
  }
}

/** Keeps `rows` for the next run: written whole, then moved into place, readable only by the person. */
export function keepRows(home: string, rows: readonly HomeRow[]): void {
  const path = homeCachePath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, keptRecord(rows), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    // A home that can't be written keeps nothing; the next run reads the live list as before.
  }
}
