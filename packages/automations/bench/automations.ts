import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileSchedule,
  AutomationStore,
  AutomationService,
  githubEvents,
  type GithubState,
  type GithubTrigger,
} from "../src/index.ts";
import type { Automation } from "@ace/protocol";
const start = Date.parse("2024-01-01T09:00:00Z");
function bench(name: string, n: number, operation: (i: number) => void) {
  const at = performance.now();
  for (let i = 0; i < n; i++) operation(i);
  const elapsed = performance.now() - at;
  console.log(
    `${name}: ${((n / elapsed) * 1000).toFixed(0)} ops/s, ${((elapsed / n) * 1000).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`,
  );
}
const recurrence = compileSchedule({
  kind: "rrule",
  expression: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9",
  timezone: "America/Chicago",
  startAt: start,
});
let cursor = start;
bench("weekday RRULE", 20_000, () => {
  cursor = recurrence.next(cursor) ?? cursor;
});
const cron = compileSchedule({
  kind: "cron",
  expression: "*/5 * * * *",
  timezone: "America/Chicago",
  startAt: start,
});
cursor = start;
bench("five-minute cron", 20_000, () => {
  cursor = cron.next(cursor) ?? cursor;
});
const counted = compileSchedule({
  kind: "rrule",
  expression: "FREQ=MINUTELY;COUNT=1000000",
  timezone: "America/Chicago",
  startAt: start,
});
let occurrence = counted.seek(start - 1);
bench("counted cursor advance", 20_000, () => {
  if (occurrence) occurrence = counted.seek(occurrence.at, occurrence);
});
const trigger: GithubTrigger = {
  kind: "github",
  event: "pr_changed",
  repository: "owner/repo",
  pollIntervalMs: 60_000,
};
const previous: GithubState = {
  pages: [
    {
      endpoint: "repos/owner/repo/pulls",
      entries: Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        version: "v1",
        labels: [],
        variables: { number: String(i) },
      })),
    },
  ],
};
const current: GithubState = {
  pages: previous.pages.map((page) => ({
    ...page,
    entries: page.entries.map((entry, i) => (i === 50 ? { ...entry, version: "v2" } : entry)),
  })),
};
bench("100 PR snapshot / one change", 20_000, () => {
  githubEvents(trigger, previous, current);
});
const root = mkdtempSync(join(tmpdir(), "ace-automations-bench-"));
const store = new AutomationStore(join(root, "auto.sqlite"));
let id = 0;
const service = new AutomationService(store, {
  now: () => start,
  random: () => 0,
  id: () => String(++id),
  timer: {
    arm() {
      return () => {};
    },
  },
  onError: console.error,
  executor: {
    async execute() {
      return { threadId: "thread", status: "succeeded", result: "done" };
    },
    async recover() {
      return undefined;
    },
  },
});
service.start();
const automation: Automation = {
  id: "bench",
  title: "Bench",
  enabled: true,
  provider: "codex",
  workspace: "/project",
  prompt: "{{missing}}",
  worktree: true,
  trigger: { kind: "manual" },
  missedRun: "skip",
  concurrency: 1,
  jitterMs: 0,
};
service.put(automation);
try {
  bench("durable admission + template failure", 10_000, (i) => {
    service.trigger("bench", { key: String(i), variables: {} });
  });
  bench("durable dedup over 10k records", 10_000, (i) => {
    service.trigger("bench", { key: String(i), variables: {} });
  });
  service.put({ ...automation, id: "execution", prompt: "Review {{path}}" });
  const executionStart = performance.now();
  for (let i = 0; i < 5000; i++) {
    service.trigger("execution", { key: String(i), variables: { path: "src/main.ts" } }, "file");
    await service.settled();
  }
  const elapsed = performance.now() - executionStart;
  console.log(
    `file admission + executor + outcome: ${((5000 / elapsed) * 1000).toFixed(0)} ops/s, ${((elapsed / 5000) * 1000).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`,
  );
  for (let i = 0; i < 998; i++)
    store.put(
      {
        ...automation,
        id: `schedule-${i}`,
        trigger: {
          kind: "schedule",
          schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC", startAt: start },
        },
      },
      start + i,
      start + i,
    );
  bench("indexed next deadline / 1000 jobs", 10000, () => {
    store.next();
  });
  bench("indexed inbox page over 15k records", 10_000, () => {
    service.inbox(20);
  });
} finally {
  service.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
