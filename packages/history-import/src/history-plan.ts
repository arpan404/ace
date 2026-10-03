import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { object, string } from "@ace/native-session";
import { Completion, nativeCompletions } from "./native-tools.ts";
import { sourceRecords } from "./source-records.ts";
import type { ProviderHome } from "./contracts.ts";
import type { Source } from "./catalog.ts";

/** Disk holds ancestry and result lookups; memory holds one bounded native record. */
export async function prepareHistory(
  instance: ProviderHome,
  source: Source,
  scratchRoot: string,
  signal: AbortSignal,
) {
  if (instance.provider === "opencode")
    return {
      includes: (_position: number) => true,
      completion: (_id: string): Completion | undefined => undefined,
      recordCall: (_nativeId: string, _itemId: string) => {},
      callItem: (_id: string): string | undefined => undefined,
      close: async () => {},
    };
  const dir = await mkdtemp(join(scratchRoot, "history-plan-"));
  const db = new DatabaseSync(join(dir, "plan.sqlite"));
  const close = async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    db.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE ancestry(ordinal INTEGER PRIMARY KEY,uuid TEXT UNIQUE,parent TEXT,selected INTEGER); CREATE TABLE results(id TEXT,ordinal INTEGER,data TEXT,PRIMARY KEY(id,ordinal)); CREATE TABLE calls(id TEXT PRIMARY KEY,item TEXT); BEGIN",
    );
    const node = db.prepare(
      "INSERT INTO ancestry VALUES(?,?,?,0) ON CONFLICT(uuid) DO UPDATE SET ordinal=excluded.ordinal,parent=excluded.parent",
    );
    const result = db.prepare("INSERT OR REPLACE INTO results VALUES(?,?,?)");
    let ordinal = 0,
      leaf: string | undefined;
    for await (const record of sourceRecords(instance, source, signal, scratchRoot)) {
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
      if (Number(row.selected)) throw new Error("Cyclic Claude conversation ancestry");
      select.run(leaf);
      leaf = string(row.parent);
    }
    if (hasAncestry)
      db.exec(
        "DELETE FROM results WHERE ordinal IN (SELECT ordinal FROM ancestry WHERE selected=0)",
      );
    const included = db.prepare("SELECT selected FROM ancestry WHERE ordinal=?");
    const completion = db.prepare(
      "SELECT data FROM results WHERE id=? ORDER BY ordinal DESC LIMIT 1",
    );
    const putCall = db.prepare(
      "INSERT INTO calls VALUES(?,?) ON CONFLICT(id) DO UPDATE SET item=excluded.item",
    );
    const getCall = db.prepare("SELECT item FROM calls WHERE id=?");
    return {
      recordCall: (nativeId: string, itemId: string) => {
        putCall.run(nativeId, itemId);
      },
      callItem: (id: string) => string(getCall.get(id)?.item),
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
