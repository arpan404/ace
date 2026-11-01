import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { object, string } from "@ace/native-session";
import { Completion, nativeCompletions } from "./native-tools.ts";
import { sourceRecords } from "./source-records.ts";
import { compactSummaryOf, inlineRawBytes, type CompactSummary } from "./compact-summary.ts";
import type { ProviderHome } from "./contracts.ts";
import type { Source } from "./catalog.ts";
import type { SnapshotScratch } from "./snapshot-scratch.ts";

/** Disk holds ancestry and result lookups; memory holds one bounded native record. */
export async function prepareHistory(
  instance: ProviderHome,
  source: Source,
  scratch: SnapshotScratch,
  signal: AbortSignal,
) {
  if (instance.provider === "opencode")
    return {
      includes: (_position: number) => true,
      completion: (_id: string): Completion | undefined => undefined,
      recordCall: (_nativeId: string, _itemId: string) => {},
      callItem: (_id: string): string | undefined => undefined,
      compactSummary: (_boundary: string): CompactSummary | undefined => undefined,
      foldsSummary: (_uuid: string) => false,
      close: async () => {},
    };
  const dir = await scratch.workDir("history-plan");
  let db: DatabaseSync | undefined;
  const close = async () => {
    try {
      db?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  try {
    db = new DatabaseSync(join(dir, "plan.sqlite"));
    db.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE ancestry(ordinal INTEGER PRIMARY KEY,uuid TEXT UNIQUE,parent TEXT,selected INTEGER); CREATE TABLE results(id TEXT,ordinal INTEGER,data TEXT,PRIMARY KEY(id,ordinal)); CREATE TABLE calls(id TEXT PRIMARY KEY,item TEXT); CREATE TABLE boundaries(uuid TEXT PRIMARY KEY); CREATE TABLE summaries(boundary TEXT PRIMARY KEY,uuid TEXT,ordinal INTEGER,text TEXT NOT NULL,data TEXT); BEGIN",
    );
    const node = db.prepare(
      "INSERT INTO ancestry VALUES(?,?,?,0) ON CONFLICT(uuid) DO UPDATE SET ordinal=excluded.ordinal,parent=excluded.parent",
    );
    const result = db.prepare("INSERT OR REPLACE INTO results VALUES(?,?,?)");
    const boundary = db.prepare("INSERT OR IGNORE INTO boundaries VALUES(?)");
    const summary = db.prepare("INSERT OR REPLACE INTO summaries VALUES(?,?,?,?,?)");
    let ordinal = 0,
      leaf: string | undefined;
    for await (const record of sourceRecords(instance, source, signal, scratch)) {
      if (++ordinal % 64 === 0) await setImmediate();
      signal.throwIfAborted();
      if (!("value" in record)) continue;
      const r = object(record.value);
      if (
        instance.provider === "claude" &&
        ["user", "assistant", "system"].includes(String(r.type))
      ) {
        const uuid = string(r.uuid);
        if (uuid && Object.hasOwn(r, "parentUuid")) {
          node.run(ordinal, uuid, string(r.parentUuid) ?? null);
          leaf = uuid;
        }
      }
      // Claude's compaction summary continues its boundary: the boundary's item carries it.
      if (instance.provider === "claude") {
        const uuid = string(r.uuid);
        if (r.type === "system" && r.subtype === "compact_boundary" && uuid) boundary.run(uuid);
        const found = compactSummaryOf(record.value);
        if (found)
          summary.run(
            found.boundary,
            uuid ?? null,
            ordinal,
            found.text,
            record.bytes <= inlineRawBytes ? JSON.stringify(record.value) : null,
          );
      }
      const piId = string(r.id);
      if (instance.provider === "pi" && piId && Object.hasOwn(r, "parentId")) {
        node.run(ordinal, piId, string(r.parentId) ?? null);
        leaf = piId;
      }
      for (const completion of nativeCompletions(record.value, instance.provider))
        result.run(completion.id, ordinal, JSON.stringify(completion));
    }
    db.exec("COMMIT");
    db.exec("BEGIN");
    const hasAncestry = leaf !== undefined;
    const get = db.prepare("SELECT parent,selected FROM ancestry WHERE uuid=?");
    const select = db.prepare("UPDATE ancestry SET selected=1 WHERE uuid=?");
    let ancestors = 0;
    while (leaf) {
      if (++ancestors % 64 === 0) await setImmediate();
      signal.throwIfAborted();
      const row = get.get(leaf);
      if (!row) break;
      if (Number(row.selected)) throw new Error("Cyclic native conversation ancestry");
      select.run(leaf);
      leaf = string(row.parent);
    }
    if (hasAncestry)
      db.exec(
        "DELETE FROM results WHERE ordinal IN (SELECT ordinal FROM ancestry WHERE selected=0); DELETE FROM summaries WHERE ordinal IN (SELECT ordinal FROM ancestry WHERE selected=0)",
      );
    const included = db.prepare("SELECT selected FROM ancestry WHERE ordinal=?");
    const completion = db.prepare(
      "SELECT data FROM results WHERE id=? ORDER BY ordinal DESC LIMIT 1",
    );
    const putCall = db.prepare(
      "INSERT INTO calls VALUES(?,?) ON CONFLICT(id) DO UPDATE SET item=excluded.item",
    );
    const getCall = db.prepare("SELECT item FROM calls WHERE id=?");
    const getSummary = db.prepare("SELECT text,data FROM summaries WHERE boundary=?");
    const folded = db.prepare(
      "SELECT 1 AS folded FROM summaries s JOIN boundaries b ON b.uuid=s.boundary WHERE s.uuid=? AND s.data IS NOT NULL",
    );
    return {
      recordCall: (nativeId: string, itemId: string) => {
        putCall.run(nativeId, itemId);
      },
      callItem: (id: string) => string(getCall.get(id)?.item),
      /** The summary that continues a compaction boundary, found ahead of it. */
      compactSummary: (boundaryUuid: string): CompactSummary | undefined => {
        const row = getSummary.get(boundaryUuid);
        const text = string(row?.text);
        if (!text) return undefined;
        const data = string(row?.data);
        return data === undefined ? { text } : { text, data: JSON.parse(data) };
      },
      /** Whether this summary record's raw already travels on its boundary's compaction. */
      foldsSummary: (uuid: string) => folded.get(uuid) !== undefined,
      includes: (position: number) =>
        !hasAncestry || Number(included.get(position)?.selected ?? 1) === 1,
      completion: (id: string) => {
        const row = completion.get(id);
        return row ? Completion.parse(JSON.parse(String(row.data))) : undefined;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
