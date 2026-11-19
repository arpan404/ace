import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Event, type EventPayload, type ThreadId } from "@ace/protocol";
import { decodeStoredPayload } from "../src/stored-decode.ts";
import { Store } from "../src/store.ts";

/**
 * CPU per event on the store's write path: one real thread's events, read from a database copy,
 * appended one at a time into a fresh temporary store, as the engine appends folded facts.
 * Read-only against the copy:
 *
 *   bun apps/daemon/bench/event-writes.ts /tmp/ace-clone/events.sqlite [events] [rounds]
 *
 * Run it on two checkouts in alternation and compare medians; the host load moves wall time,
 * so only CPU is reported. It also times `Event.parse` and `structuredClone` alone over the
 * same payloads, the two whole-object passes the write path used to make per event.
 */
const path = process.argv[2];
if (!path) throw new Error("usage: event-writes.ts <events.sqlite copy> [events] [rounds]");
const limit = Number(process.argv[3] ?? 3000);
const rounds = Number(process.argv[4] ?? 7);
const source = new DatabaseSync(path, { readOnly: true });
type Row = { thread_id: string; at: number; payload: string };
// The newest thread whose whole history (from its creation) is at least `limit` events long.
const thread = source
  .prepare(
    `SELECT thread_id FROM events WHERE type = 'thread.created' AND
      (SELECT COUNT(*) FROM events e WHERE e.thread_id = events.thread_id) >= ?
     ORDER BY seq DESC LIMIT 1`,
  )
  .get(limit)?.thread_id;
if (typeof thread !== "string") throw new Error("No thread that long");
const rows = source
  .prepare("SELECT thread_id, at, payload FROM events WHERE thread_id = ? ORDER BY seq LIMIT ?")
  .all(thread, limit) as Row[];
source.close();
const payloads = rows.map((row) => decodeStoredPayload(JSON.parse(row.payload)));
const types = new Map<string, number>();
for (const payload of payloads) types.set(payload.type, (types.get(payload.type) ?? 0) + 1);

function replay(): { cpuMs: number; failed: number } {
  const root = mkdtempSync(join(tmpdir(), "ace-event-writes-"));
  let id = 0;
  const store = new Store(join(root, "events.sqlite"), () => {}, {
    nextId: () => `event-${String(++id).padStart(8, "0")}`,
  });
  try {
    const workspaceId = store.createWorkspace(root, "Bench");
    // Each append gets its own copy: the writer owns what it is given.
    const inputs: EventPayload[] = payloads.map((payload) =>
      payload.type === "thread.created"
        ? { ...payload, thread: { ...payload.thread, workspaceId } }
        : structuredClone(payload),
    );
    let failed = 0;
    const cpu = process.cpuUsage();
    for (const [index, payload] of inputs.entries()) {
      try {
        store.appendEvents(thread as ThreadId, [payload], rows[index]?.at ?? 0);
      } catch {
        failed++;
      }
    }
    const used = process.cpuUsage(cpu);
    return { cpuMs: (used.user + used.system) / 1000, failed };
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function alone(pass: (payload: EventPayload, index: number) => unknown): number {
  const cpu = process.cpuUsage();
  for (const [index, payload] of payloads.entries()) pass(payload, index);
  const used = process.cpuUsage(cpu);
  return (used.user + used.system) / 1000;
}
const parse = (payload: EventPayload, index: number) =>
  Event.parse({ seq: index + 1, id: `e${index}`, threadId: thread, at: 0, payload });
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
const runs = { write: [] as number[], parse: [] as number[], clone: [] as number[] };
let failed = 0;
replay();
for (let round = 0; round < rounds; round++) {
  const result = replay();
  failed = result.failed;
  runs.write.push(result.cpuMs);
  runs.parse.push(alone(parse));
  runs.clone.push(alone((payload) => structuredClone(payload)));
}
const perEvent = (ms: number) => Number(((ms * 1000) / payloads.length).toFixed(2));
console.log(
  JSON.stringify(
    {
      events: payloads.length,
      failed,
      types: Object.fromEntries([...types].toSorted((a, b) => b[1] - a[1])),
      cpuMicrosecondsPerEvent: {
        append: perEvent(median(runs.write)),
        eventParseAlone: perEvent(median(runs.parse)),
        structuredCloneAlone: perEvent(median(runs.clone)),
      },
      rounds,
    },
    null,
    2,
  ),
);
