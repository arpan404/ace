/** Synthetic public-API pool benchmark. Run only at merge, per repository owner policy. */
import { performance } from "node:perf_hooks";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { cleanup, poolWorld, paired, ref, key, wait } from "../src/machines-process.fixture.ts";

async function measure(hosts: number, threadsPerHost: number) {
  const before = process.memoryUsage();
  const f = poolWorld({ threadCount: threadsPerHost });
  const started = performance.now();
  try {
    for (let i = 0; i < hosts; i++) await f.pool.add(paired(`host-${i}`));
    for (const hostId of f.pool.ids)
      await wait(f.pool.status(hostId), (state) => state?.status === "online", 60000);
    await wait(
      f.pool.threads.select(["ids"], (store) => store.ids.length),
      (length) => length === hosts * threadsPerHost,
      60000,
    );
    const startupMs = performance.now() - started;
    let predicateReads = 0;
    const count = f.pool.threads.count((row) => {
      predicateReads++;
      return row.thread.title.startsWith("update-");
    });
    const stop = count.subscribe(() => {});
    predicateReads = 0;
    let changes = 0;
    const unobserve = f.pool.threads.observeChanges(() => changes++);
    const latencies: number[] = [];
    async function rename(hostId: string, i: number) {
      const begin = performance.now();
      const title = `update-${i}`;
      const result = await f.pool.command(ref(hostId), {
        type: "thread.rename",
        threadId: ThreadId.parse("shared"),
        title,
      });
      if (!result.ok) throw new Error("Synthetic command refused");
      await wait(
        f.pool.threads.select(
          [`thread:${key(hostId)}`],
          (store) => store.thread(key(hostId))?.thread.title,
        ),
        (value) => value === title,
      );
      latencies.push(performance.now() - begin);
    }
    const begin = performance.now();
    for (let i = 0; i < 100; i++) await Promise.all(f.pool.ids.map((hostId) => rename(hostId, i)));
    const deltaMs = performance.now() - begin;
    const observedChanges = changes;
    const readsPerChange = predicateReads / observedChanges;
    if (count.getSnapshot() !== hosts || observedChanges !== hosts * 100)
      throw new Error("Merged delivery incomplete");
    let blockedHostLatencyMs: number | undefined;
    if (hosts > 1) {
      await f.control("host-0", "block");
      const isolationStart = performance.now();
      try {
        await rename("host-1", 100);
      } finally {
        f.unblock("host-0");
      }
      blockedHostLatencyMs = performance.now() - isolationStart;
    }
    latencies.sort((a, b) => a - b);
    const memory = process.memoryUsage();
    console.log(
      JSON.stringify({
        name: "dedicated-worker MachinePool",
        node: process.version,
        hosts,
        threadsPerHost,
        rows: f.pool.threads.ids.length,
        startupMs,
        changes: observedChanges,
        changesPerSecond: (observedChanges * 1000) / deltaMs,
        commandToMergedP95Ms: latencies[Math.floor(latencies.length * 0.95)],
        countPredicateReadsPerChange: readsPerChange,
        blockedHostLatencyMs,
        parentHeapMiB: memory.heapUsed / 1048576,
        parentHeapGrowthMiB: (memory.heapUsed - before.heapUsed) / 1048576,
        processRssMiB: memory.rss / 1048576,
        processRssGrowthMiB: (memory.rss - before.rss) / 1048576,
      }),
    );
    stop();
    unobserve();
  } finally {
    for (const close of cleanup.splice(0).toReversed()) await close();
  }
}

if (process.argv.length > 2) {
  const [hosts, threadsPerHost] = z
    .tuple([
      z.coerce.number().int().min(1).max(3),
      z.coerce.number().pipe(z.union([z.literal(100), z.literal(1000), z.literal(5000)])),
    ])
    .parse(process.argv.slice(2));
  await measure(hosts, threadsPerHost);
} else {
  for (const hosts of [1, 2, 3])
    for (const threadsPerHost of [100, 1000, 5000]) await measure(hosts, threadsPerHost);
}
