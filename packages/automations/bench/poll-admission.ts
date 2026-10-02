import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomationService,
  AutomationStore,
  type GithubState,
  type GhResponse,
} from "../src/index.ts";
import type { Automation } from "@ace/protocol";
const at = Date.parse("2024-01-01T09:00:00Z");
const body = "x".repeat(8192);
const automation: Automation = {
  id: "bench",
  title: "Bench",
  enabled: true,
  provider: "codex",
  workspace: "/project",
  prompt: "{{number}}",
  worktree: true,
  trigger: {
    kind: "github",
    repository: "owner/repo",
    event: "pr_changed",
    pollIntervalMs: 60_000,
  },
  missedRun: "skip",
  concurrency: 32,
  jitterMs: 0,
};
const base = "repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=100";
function endpoint(page: number) {
  return page === 0 ? base : `${base}&page=${page + 1}`;
}
function snapshot(count: number): GithubState {
  return {
    pages: Array.from({ length: Math.ceil(count / 100) }, (_, page) => ({
      endpoint: endpoint(page),
      etag: '"cached"',
      ...(page + 1 < Math.ceil(count / 100) ? { next: endpoint(page + 1) } : {}),
      entries: Array.from({ length: Math.min(100, count - page * 100) }, (_entry, j) => ({
        id: String(page * 100 + j + 1),
        version: "v1",
        labels: [],
        variables: { number: String(page * 100 + j + 1), body },
      })),
    })),
  };
}
function report(name: string, count: number, start: number) {
  const elapsed = performance.now() - start;
  console.log(
    `${name}: ${((count / elapsed) * 1000).toFixed(0)} ops/s, ${((elapsed / count) * 1000).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`,
  );
}
const root = mkdtempSync(join(tmpdir(), "ace-poll-bench-"));
const store = new AutomationStore(join(root, "auto.sqlite"));
let clock = at,
  ids = 0,
  version = 1,
  changes = 0;
let callback: (() => void | Promise<void>) | undefined;
const service = new AutomationService(
  store,
  {
    now: () => clock,
    random: () => 0,
    id: () => String(++ids),
    timer: {
      arm(_delay, receive) {
        callback = receive;
        return () => {
          callback = undefined;
        };
      },
    },
    onError(error) {
      throw error;
    },
    executor: {
      async execute() {
        return { threadId: "thread", status: "succeeded", result: "done" };
      },
      async recover() {
        return undefined;
      },
    },
  },
  {
    async get(path): Promise<GhResponse> {
      const page = Math.max(
        0,
        Number(new URL(path, "https://api.github.com").searchParams.get("page") ?? 1) - 1,
      );
      return {
        status: 200,
        etag: `"${version}"`,
        next: page < 9 ? endpoint(page + 1) : undefined,
        data: Array.from({ length: 100 }, (_, j) => {
          const id = page * 100 + j + 1;
          return {
            id,
            number: id,
            updated_at: id <= changes ? `v${version}` : "v1",
            html_url: `https://github.com/owner/repo/pull/${id}`,
            body,
          };
        }),
      };
    },
  },
);
service.start();
try {
  service.put({ ...automation, prompt: "{{missing}}" });
  for (const size of [0, 100, 1000]) {
    store.savePoll("bench", snapshot(size));
    const start = performance.now();
    for (let i = 0; i < 1000; i++) service.trigger("bench", { key: `${size}:${i}`, variables: {} });
    report(`durable admission / ${size} cached entries`, 1000, start);
  }
  for (let i = 0; i < 30; i++) {
    service.put({ ...automation, id: `list-${i}`, enabled: false });
    store.savePoll(`list-${i}`, snapshot(100));
  }
  if (global.gc) {
    global.gc();
    const heap = process.memoryUsage().heapUsed;
    const count = service.list().length;
    console.log(
      `list ${count} definitions / 30 x 0.79 MiB snapshots: heap allocation ${((process.memoryUsage().heapUsed - heap) / 1048576).toFixed(3)} MiB`,
    );
  }
  const listStart = performance.now();
  for (let i = 0; i < 1000; i++) service.list();
  report("list 31 definitions / 30 x 0.79 MiB snapshots", 1000, listStart);
  for (let i = 0; i < 30; i++) service.remove(`list-${i}`);
  service.put(automation);
  for (const count of [1, 100, 1000]) {
    changes = count;
    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      store.savePoll("bench", snapshot(1000));
      version++;
      clock += 60_000;
      const fire = callback;
      if (!fire) throw new Error("Missing deadline");
      await fire();
      await service.settled();
    }
    report(`composed poll + admission + outcomes / 1000 cached / ${count} changes`, 10, start);
  }
} finally {
  service.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
