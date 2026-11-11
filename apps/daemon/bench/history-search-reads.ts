import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { ThreadId } from "@ace/protocol";
import { HistoryIndex } from "../src/history-index.ts";
import { ItemTextStore } from "../src/item-text-store.ts";
import { PayloadStore } from "../src/payload-store.ts";
import { SearchReplay } from "../src/search-replay.ts";
import { decodeStoredItem, untrusted, type StoredTrust } from "../src/stored-decode.ts";

/**
 * CPU per history page, search replay page and text preview, decoding every stored row (what
 * older rows still get) against reading rows this build wrote as stored (ADR 0125). Read-only,
 * against a database copy:
 *
 *   cp -c ~/.ace/events.sqlite /tmp/ace-clone/ && bun apps/daemon/bench/history-search-reads.ts /tmp/ace-clone/events.sqlite
 *
 * It also reports how many of the newest history revisions and text previews decode to something
 * other than their stored JSON, and checks that both modes return the same pages.
 */
const path = process.argv[2];
if (!path) throw new Error("usage: history-search-reads.ts <events.sqlite copy> [rows]");
const sample = Number(process.argv[3] ?? 20000);
const db = new DatabaseSync(path, { readOnly: true });
const prepared = new Map<string, StatementSync>();
const statement = (sql: string) => {
  let found = prepared.get(sql);
  if (!found) prepared.set(sql, (found = db.prepare(sql)));
  return found;
};
const head = Number(db.prepare("SELECT max(seq) AS seq FROM events").get()?.seq);

function readers(trust: StoredTrust) {
  const payloads = new PayloadStore(db, () => "unused", statement, trust);
  const history = new HistoryIndex(
    db,
    statement,
    (stream, offset, limit) => payloads.readOutputBytes(stream, offset, limit),
    () => {
      throw new Error("read-only bench");
    },
    trust,
  );
  return {
    history,
    search: new SearchReplay(db, history, trust),
    texts: new ItemTextStore(db, trust),
  };
}
const modes = { decoded: readers(untrusted()), trusted: readers({ from: 0 }) };

const threads = db
  .prepare(
    "SELECT thread_id FROM history_items GROUP BY thread_id ORDER BY max(created_seq) DESC LIMIT 40",
  )
  .all()
  .map((row) => ThreadId.parse(row.thread_id));
const previews = db
  .prepare("SELECT id FROM item_previews ORDER BY rowid DESC LIMIT ?")
  .all(Math.min(sample, 4000))
  .map((row) => String(row.id));

type Readers = ReturnType<typeof readers>;
const operations = {
  historyPage: {
    count: threads.length,
    run: (r: Readers) =>
      threads.map((thread) =>
        r.history.page(thread, head, Number.MAX_SAFE_INTEGER, 50, 256 * 1024),
      ),
  },
  searchPage: {
    count: 20,
    run: (r: Readers) => {
      const pages = [];
      let afterSeq = head - sample;
      for (let page = 0; page < 20; page++) {
        const read = r.search.read({ afterSeq, limit: 256, maxBytes: 512 * 1024 }, head);
        pages.push(read);
        afterSeq = read.throughSeq;
      }
      return pages;
    },
  },
  textPreview: {
    count: previews.length,
    run: (r: Readers) => previews.map((id) => r.texts.read(id)),
  },
};

const same: Record<string, boolean> = {};
for (const [name, op] of Object.entries(operations))
  same[name] = isDeepStrictEqual(op.run(modes.decoded), op.run(modes.trusted));

const changed = (sql: string) => {
  let count = 0;
  for (const row of db.prepare(sql).iterate(sample)) {
    const raw: unknown = JSON.parse(String(row.item));
    if (!isDeepStrictEqual(decodeStoredItem(raw), raw)) count++;
  }
  return count;
};
const revisionsChanged = changed(
  "SELECT item FROM history_item_revisions ORDER BY seq DESC LIMIT ?",
);
const previewsChanged = changed("SELECT item FROM item_previews ORDER BY rowid DESC LIMIT ?");

const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
const results: Record<string, unknown> = {};
for (const [name, op] of Object.entries(operations)) {
  const runs = { decoded: [] as number[], trusted: [] as number[] };
  for (let round = 0; round < 11; round++)
    for (const mode of ["decoded", "trusted"] as const) {
      const cpu = process.cpuUsage();
      op.run(modes[mode]);
      const used = process.cpuUsage(cpu);
      runs[mode].push(used.user + used.system);
    }
  const decoded = median(runs.decoded) / op.count;
  const trusted = median(runs.trusted) / op.count;
  results[name] = {
    operations: op.count,
    decodedUsPerOp: Math.round(decoded),
    trustedUsPerOp: Math.round(trusted),
    ratio: +(decoded / trusted).toFixed(2),
    samePages: same[name],
  };
}
console.log(
  JSON.stringify({ head, ...results, sample, revisionsChanged, previewsChanged }, null, 2),
);
