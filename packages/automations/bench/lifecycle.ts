import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationService, AutomationStore, type ExecutionResult } from "../src/index.ts";
const root = mkdtempSync(join(tmpdir(), "ace-lifecycle-bench-"));
const store = new AutomationStore(join(root, "auto.sqlite"));
let ids = 0;
const observe = (signal: AbortSignal): Promise<ExecutionResult> =>
  new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => resolve({ threadId: "obsolete", status: "succeeded", result: "obsolete" }),
      { once: true },
    );
  });
const service = new AutomationService(store, {
  now: () => 0,
  random: () => 0,
  id: () => String(++ids),
  onError: console.error,
  timer: {
    arm() {
      return () => {};
    },
  },
  executor: {
    execute(_input, signal) {
      return observe(signal);
    },
    recover(_key, signal) {
      return observe(signal);
    },
  },
});
try {
  service.start();
  service.put({
    id: "bench",
    title: "Bench",
    enabled: true,
    workspace: "/project",
    provider: "codex",
    prompt: "Review",
    worktree: false,
    trigger: { kind: "manual" },
    missedRun: "skip",
    concurrency: 1,
    jitterMs: 0,
  });
  service.trigger("bench", { key: "pending", variables: {} });
  const start = performance.now();
  for (let i = 0; i < 2000; i++) {
    service.stop();
    await service.settled();
    service.start();
  }
  const elapsed = performance.now() - start;
  console.log(
    `restart + recovery + cancellation / one pending run: ${(2000000 / elapsed).toFixed(0)} ops/s, ${((elapsed / 2000) * 1000).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`,
  );
} finally {
  service.stop();
  await service.settled();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
