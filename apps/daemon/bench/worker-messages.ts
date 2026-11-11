import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Event, Item, Thread } from "@ace/protocol";
import { NotificationWorker } from "@ace/notify";
import { SearchIndex, SearchQueries } from "@ace/search";

/**
 * CPU per round trip on the daemon's two busiest worker channels. Search: the query goes to the
 * worker, 100 ranked hits come back. Notifications: one ingest call carrying 16 agent status
 * changes (the daemon makes one per appended batch), acknowledged by the worker. Reports the
 * main thread's CPU (where the daemon's event loop runs) and the whole process's (main plus
 * worker), per round trip, as medians of interleaved rounds. The host may be loaded, so compare CPU, not wall time, and compare runs of this
 * script on two builds against each other:
 *
 *   bun apps/daemon/bench/worker-messages.ts [rounds] [round-trips-per-round]
 */
const rounds = Number(process.argv[2] ?? 9);
const perRound = Number(process.argv[3] ?? 200);
const directory = mkdtempSync(join(tmpdir(), "ace-worker-messages-"));
const path = join(directory, "events.sqlite");

const thread = Thread.parse({
  id: "benchthread",
  workspaceId: "benchworkspace",
  provider: "codex",
  title: "Compiler investigation",
  status: { state: "done" },
  createdAt: 1,
  updatedAt: 1,
});
const db = new DatabaseSync(path);
db.exec("PRAGMA journal_mode=WAL");
const index = new SearchIndex(db);
let seq = 0;
const event = (payload: Event["payload"]) =>
  Event.parse({ seq: ++seq, id: `event${seq}`, threadId: thread.id, at: seq, payload });
index.append([event({ type: "thread.created", thread })]);
for (let offset = 0; offset < 2000; offset += 200) {
  const batch: Event[] = [];
  for (let i = offset; i < offset + 200; i++)
    batch.push(
      event({
        type: "item.created",
        item: Item.parse({
          id: `item${i}`,
          agentId: "benchagent",
          type: "message",
          role: "assistant",
          createdAt: i + 2,
          complete: true,
          parts: [
            {
              type: "text",
              text: `The benchword compiler pass ${i} rewrote module${i % 97}.ts and reported diagnostic ${i} with a longer explanation of what changed and why it matters for the build.`,
            },
          ],
        }),
      }),
    );
  index.append(batch);
}
while (index.flush(256) > 0);

const queries = new SearchQueries(path);
const query = { text: "benchword compiler", limit: 100 };
const first = await queries.query(query);
if (first.hits.length !== 100) throw new Error(`expected 100 hits, got ${first.hits.length}`);

const notifications = new NotificationWorker({
  path: ":memory:",
  windowMs: 0,
  transport: { send: async () => "accepted" },
});
// Built before measuring, so only the channel's own work is counted.
let notifySeq = 0;
const batches = Array.from({ length: 100 + rounds * perRound }, () =>
  Array.from({ length: 16 }, () => {
    notifySeq++;
    return Event.parse({
      seq: notifySeq,
      id: `notify${notifySeq}`,
      threadId: thread.id,
      at: notifySeq,
      payload:
        notifySeq === 1
          ? { type: "thread.created", thread }
          : {
              type: "agent.status",
              agentId: "benchagent",
              status: { state: "working", activity: "tool" },
            },
    });
  }),
);
let nextBatch = 0;

const cpu = (usage: NodeJS.CpuUsage) => usage.user + usage.system;
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
const channels = [
  { channel: "search", trip: () => queries.query(query) },
  { channel: "notify.ingest", trip: () => notifications.ingest(batches[nextBatch++] ?? []) },
];
const samples = channels.map(() => ({ main: [] as number[], whole: [] as number[] }));
for (const { trip } of channels) for (let warm = 0; warm < 100; warm++) await trip();
// Interleaved: every round measures each channel once, so load on the host hits them alike.
for (let round = 0; round < rounds; round++)
  for (const [slot, { trip }] of channels.entries()) {
    const thread0 = process.threadCpuUsage();
    const process0 = process.cpuUsage();
    for (let i = 0; i < perRound; i++) await trip();
    samples[slot]?.main.push(cpu(process.threadCpuUsage(thread0)) / perRound);
    samples[slot]?.whole.push(cpu(process.cpuUsage(process0)) / perRound);
  }
for (const [slot, { channel }] of channels.entries())
  console.log(
    JSON.stringify({
      channel,
      rounds,
      perRound,
      mainCpuUsPerRoundTrip: Math.round(median(samples[slot]?.main ?? [])),
      processCpuUsPerRoundTrip: Math.round(median(samples[slot]?.whole ?? [])),
    }),
  );
await queries.close();
await notifications.close();
db.close();
rmSync(directory, { recursive: true, force: true });
