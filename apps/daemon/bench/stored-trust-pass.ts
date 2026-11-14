import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadId } from "@ace/protocol";
import { createDevThread } from "../src/commands.ts";
import { message } from "../src/payload-test-support.ts";
import { Store } from "../src/store.ts";

/**
 * What reading older history costs once a schema change moved the trusted boundary to the head,
 * and again after the idle pass (`stored-trust-pass.ts`) confirmed it. Builds its own fixture in
 * a temp directory, never touching ~/.ace:
 *
 *   bun apps/daemon/bench/stored-trust-pass.ts [threads] [messages per thread]
 *
 * Prints the fixture's path so `stored-reads.ts` and `thread-rows.ts` can run against it too.
 */
const threads = Number(process.argv[2] ?? 40);
const perThread = Number(process.argv[3] ?? 500);
const path = join(mkdtempSync(join(tmpdir(), "ace-trust-bench-")), "events.sqlite");
const pass: { tick?: () => void; finished: boolean } = { finished: false };
const open = (eventShape: string) =>
  new Store(path, console.error, {
    eventShape,
    trustPass: {
      batchesPerTick: 1,
      scheduler: (run) => {
        pass.tick = run;
        return () => {
          pass.finished = true;
        };
      },
    },
  });

const writer = open("older build");
const workspace = writer.createWorkspace("/repo", "Repo", 1);
const ids: ThreadId[] = [];
const text = "A paragraph of agent output, long enough to look like a real reply. ".repeat(6);
for (let thread = 0; thread < threads; thread++) {
  const id = createDevThread(writer, workspace).id;
  ids.push(id);
  for (let start = 0; start < perThread; start += 100)
    writer.appendEvents(
      id,
      Array.from({ length: Math.min(100, perThread - start) }, (_, index) => ({
        type: "item.created" as const,
        item: message(`t${thread}-m${start + index}`, text),
      })),
    );
}
await writer.close();

pass.finished = false;
const store = open("this build");
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;
function cpu(run: () => void): number {
  const start = process.cpuUsage();
  run();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}
function replay() {
  let after = 0;
  for (;;) {
    const page = store.readEvents({ afterSeq: after, limit: 500 });
    const last = page.at(-1);
    if (!last) return;
    after = last.seq;
  }
}
function openThreads() {
  for (const id of ids) {
    store.releaseThread(id);
    store.readItems(id, Number.MAX_SAFE_INTEGER, 200);
  }
}
function measure() {
  replay();
  openThreads();
  const rounds = { replayMs: [] as number[], threadTailsMs: [] as number[] };
  for (let round = 0; round < 7; round++) {
    rounds.replayMs.push(cpu(replay));
    rounds.threadTailsMs.push(cpu(openThreads));
  }
  return {
    replayMs: +median(rounds.replayMs).toFixed(1),
    threadTailsMs: +median(rounds.threadTailsMs).toFixed(1),
  };
}

const events = store.readEvents({ afterSeq: 0, limit: 1_000_000 }).length;
const atHead = measure();
let batches = 0;
const passMs = cpu(() => {
  while (!pass.finished && pass.tick) {
    pass.tick();
    batches++;
  }
});
const confirmed = measure();
console.log(
  JSON.stringify(
    {
      path,
      events,
      threads,
      boundaryAtHead: atHead,
      afterPass: confirmed,
      replaySpeedup: +(atHead.replayMs / confirmed.replayMs).toFixed(1),
      threadTailSpeedup: +(atHead.threadTailsMs / confirmed.threadTailsMs).toFixed(1),
      pass: {
        cpuMs: +passMs.toFixed(1),
        batches,
        usPerEvent: +((passMs * 1000) / events).toFixed(1),
      },
    },
    null,
    2,
  ),
);
await store.close();
