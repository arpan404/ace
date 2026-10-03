// Non-gating native snapshot ingestion benchmark. Needs run at merge, never during implementation.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../src/index.ts";
const home = mkdtempSync(join(tmpdir(), "ace-usage-snapshot-bench-"));
const store = new UsageStore(join(home, "usage.sqlite"));
const operations = 10_000;
try {
  const start = performance.now();
  for (let seq = 1; seq <= operations; seq++)
    store.ingest({
      afterSeq: seq - 1,
      throughSeq: seq,
      events: [
        {
          seq,
          at: 1790985600000,
          threadId: "bench",
          payload: {
            type: "usage.updated",
            agentId: "root",
            inputTokens: seq * 10,
            outputTokens: seq * 3,
            usageScope: "model_session",
            model: "sonnet",
            counterKey: "session:initial",
            costUsd: seq / 100,
          },
        },
      ],
    });
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      snapshotsPerSecond: (operations / elapsed) * 1000,
      microsecondsPerSnapshot: (elapsed * 1000) / operations,
      peakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  store.close();
  rmSync(home, { recursive: true, force: true });
}
