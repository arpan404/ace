import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { UsageStore, UsageEvent } from "../src/index.ts";

const home = mkdtempSync(join(tmpdir(), "ace-usage-bench-"));
const store = new UsageStore(join(home, "usage.sqlite"));
let seq = 0;
let afterSeq = 0;
let batch: UsageEvent[] = [];
const startAt = Date.parse("2026-01-01T12:00Z");
function flush() {
  if (!batch.length) return;
  store.ingest({ afterSeq, throughSeq: seq, events: batch });
  afterSeq = seq;
  batch = [];
}
function add(payload: UsageEvent["payload"], threadId: string, at = startAt) {
  batch.push({ seq: ++seq, threadId, at, payload });
  if (batch.length === 256) flush();
}
function measure(name: string, run: () => unknown) {
  run();
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const before = performance.now();
    run();
    samples.push(performance.now() - before);
  }
  const ordered = samples.toSorted((a, b) => a - b);
  process.stdout.write(
    `${name}: p50=${ordered[10]?.toFixed(2)} ms p95=${ordered[19]?.toFixed(2)} ms\n`,
  );
}
try {
  for (let thread = 0; thread < 100; thread++) {
    add({ type: "thread.created", workspace: `w${thread % 10}`, provider: "codex" }, `t${thread}`);
    for (let child = 0; child < 2; child++) {
      add(
        {
          type: "agent.created",
          id: `a${thread * 2 + child}`,
          parent: child ? `a${thread * 2}` : null,
          model: "gpt-5.3-codex",
          provider: "codex",
        },
        `t${thread}`,
      );
    }
  }
  flush();
  const start = performance.now();
  let facts = 0;
  for (let day = 0; day < 365; day++)
    for (let agent = 0; agent < 200; agent++) {
      add(
        {
          type: "usage.updated",
          agentId: `a${agent}`,
          inputTokens: (day + 1) * 1000,
          outputTokens: (day + 1) * 100,
          cachedInputTokens: (day + 1) * 300,
          reasoningTokens: (day + 1) * 20,
          accountId: `acc${agent % 5}`,
          billingMode: "api",
          counterMode: "cumulative",
          counterKey: "session",
        },
        `t${Math.floor(agent / 2)}`,
        startAt + day * 86_400_000,
      );
      facts++;
    }
  flush();
  const elapsed = performance.now() - start;
  const q = { from: "2026-01-01", to: "2026-12-31", limit: 1000 };
  process.stdout.write(
    `year rows=${facts}, ingestion=${Math.round((facts / elapsed) * 1000)} events/s (${((elapsed * 1000) / facts).toFixed(2)} us/event)\n`,
  );
  measure("year summary/provider/account", () =>
    store.summary({ ...q, groupBy: ["provider", "account"] }),
  );
  measure("provider/account fortnight series", () =>
    store.series({
      ...q,
      from: "2026-12-18",
      filters: { provider: ["codex"] },
      groupBy: ["account"],
    }),
  );
  measure("account monthly series", () =>
    store.series({ ...q, filters: { account: ["acc0"] }, groupBy: ["account"], bucket: "month" }),
  );
  measure("year daily series", () => store.series(q));
  measure("year top threads", () => store.summary({ ...q, groupBy: ["thread"], limit: 10 }));
  measure("year subtree series", () => store.series({ ...q, agentTree: "a0" }));
  // Relationship changes validate ancestor chains; usage facts above remain O(1).
  const linkStart = performance.now();
  add({ type: "thread.created", workspace: "links", provider: "codex" }, "links");
  for (let depth = 0; depth < 1000; depth++) {
    add(
      {
        type: "agent.created",
        id: `link-${depth}`,
        parent: depth ? `link-${depth - 1}` : null,
        model: null,
        provider: "codex",
      },
      "links",
    );
  }
  flush();
  process.stdout.write(
    `1000-deep relationship validation: ${(((performance.now() - linkStart) * 1000) / 1000).toFixed(2)} us/link\n`,
  );
  process.stdout.write(`peak RSS=${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`);
} finally {
  store.close();
  rmSync(home, { recursive: true, force: true });
}
