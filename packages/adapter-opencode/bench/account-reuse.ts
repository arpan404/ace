// Non-gating owned fake-process benchmark. No provider quota; execution reserved for merge.
import { performance } from "node:perf_hooks";
import { ThreadId } from "@ace/protocol";
import { boundary } from "./fake-boundary.ts";
for (const count of [1, 16, 64]) {
  const b = boundary(() => {});
  const started = performance.now();
  try {
    for (let i = 0; i < count; i++)
      await b.adapter.openSession({
        cwd: "/bench",
        threadId: ThreadId.parse(`thread_account_${i}`),
        instanceId: "benchmark-account",
        env: { ACE_TEST_INSTANCE: "benchmark-account" },
        signal: new AbortController().signal,
        onFrame: b.observe,
        onExit: () => {},
      });
    const elapsedMs = performance.now() - started;
    console.log(
      JSON.stringify({
        count,
        elapsedMs,
        sessionsPerSecond: (count * 1000) / elapsedMs,
        peakRss: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await b.adapter.close();
  }
}
