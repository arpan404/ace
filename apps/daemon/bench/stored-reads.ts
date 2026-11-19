import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { Event } from "@ace/protocol";
import { decodeStoredPayload } from "../src/stored-decode.ts";

/**
 * How much reading stored events costs with today's validation against reading rows the
 * daemon wrote itself without validating them again. Read-only, against a database copy:
 *
 *   cp -c ~/.ace/events.sqlite /tmp/ace-clone/ && bun apps/daemon/bench/stored-reads.ts /tmp/ace-clone/events.sqlite
 *
 * It also reports how many rows decode to something other than their stored JSON: rows whose
 * shape the current schema would change (older layouts, defaults filled in) can't skip it.
 */
const path = process.argv[2];
if (!path) throw new Error("usage: stored-reads.ts <events.sqlite copy> [rows]");
const limit = Number(process.argv[3] ?? 20000);
const db = new DatabaseSync(path, { readOnly: true });
type Row = { seq: number; id: string; thread_id: string; at: number; payload: string };
const rows = db
  .prepare("SELECT seq, id, thread_id, at, payload FROM events ORDER BY seq DESC LIMIT ?")
  .all(limit) as Row[];
const bytes = rows.reduce((sum, row) => sum + row.payload.length, 0);

function validated(): number {
  let total = 0;
  for (const row of rows) {
    const event = Event.parse({
      seq: row.seq,
      id: row.id,
      threadId: row.thread_id,
      at: row.at,
      payload: decodeStoredPayload(JSON.parse(row.payload)),
    });
    total += Buffer.byteLength(JSON.stringify(event));
  }
  return total;
}
function trusted(): number {
  let total = 0;
  for (const row of rows) {
    const event = {
      seq: row.seq,
      id: row.id,
      threadId: row.thread_id,
      at: row.at,
      payload: JSON.parse(row.payload),
    };
    total += row.payload.length + (event.id.length + 64);
  }
  return total;
}
let changed = 0;
const changedTypes = new Map<string, number>();
for (const row of rows) {
  const raw: unknown = JSON.parse(row.payload);
  if (!isDeepStrictEqual(decodeStoredPayload(raw), raw)) {
    changed++;
    const type = String((raw as { type?: unknown }).type);
    changedTypes.set(type, (changedTypes.get(type) ?? 0) + 1);
  }
}
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
const runs = { validated: [] as number[], trusted: [] as number[] };
validated();
trusted();
for (let round = 0; round < 15; round++)
  for (const [name, run] of [
    ["validated", validated],
    ["trusted", trusted],
  ] as const) {
    const cpu = process.cpuUsage();
    run();
    const used = process.cpuUsage(cpu);
    runs[name].push((used.user + used.system) / 1000);
  }
const v = median(runs.validated);
const t = median(runs.trusted);
console.log(
  JSON.stringify(
    {
      rows: rows.length,
      payloadMiB: +(bytes / 1048576).toFixed(1),
      validatedCpuMs: +v.toFixed(1),
      trustedCpuMs: +t.toFixed(1),
      speedup: +(v / t).toFixed(1),
      validatedUsPerRow: +((v * 1000) / rows.length).toFixed(1),
      trustedUsPerRow: +((t * 1000) / rows.length).toFixed(1),
      rowsChangedByDecode: changed,
      changedTypes: Object.fromEntries(
        [...changedTypes].toSorted((a, b) => b[1] - a[1]).slice(0, 10),
      ),
    },
    null,
    2,
  ),
);
