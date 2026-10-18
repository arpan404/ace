import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test } from "vitest";
import { message } from "../payload-test-support.ts";
import { storageFixture, storageNow } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Longest gap between ticks of a 1 ms timer while `work` runs: how long the loop was held. */
async function longestBlock(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  try {
    await work();
    longest = Math.max(longest, performance.now() - last);
  } finally {
    clearInterval(timer);
  }
  return longest;
}

test("a retention pass over a long history and many log files never holds the event loop", async () => {
  const f = await storageFixture();
  cleanups.push(() => f.close());
  // About 24 MB of transcript items in 60 recently active threads, as a daemon has after
  // weeks of use. Nothing is old enough to remove: the pass is all inventory.
  for (let thread = 0; thread < 60; thread++) {
    const t = f.thread(`history-${thread}`, { state: "done" }, {});
    f.store.appendEvents(
      t.id,
      [{ type: "thread.client.updated", changes: { activityAt: storageNow } }],
      storageNow,
    );
    for (let item = 0; item < 25; item++)
      f.store.appendEvents(
        t.id,
        [
          {
            type: "item.created",
            item: message(`history-${thread}-${item}`, "transcript ".repeat(1500)),
          },
        ],
        storageNow,
      );
  }
  // Recent log files: each one is inspected for an owning thread on every pass.
  await mkdir(join(f.root, "logs"), { recursive: true });
  for (let file = 0; file < 40; file++)
    await writeFile(join(f.root, "logs", `ace.${file}.jsonl`), "recent log line\n");

  const blocked = await longestBlock(() => f.storage.retain(120, () => true));
  // Before thread sizes yielded and file ownership was indexed, this pass held the loop for
  // the whole scan: every file parsed every item.
  expect(blocked).toBeLessThan(150);
}, 120_000);
