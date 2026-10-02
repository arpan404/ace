import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { GitService } from "@ace/git";
import { Command } from "@ace/protocol";
import { ReviewService } from "../src/index.ts";

// Non-gating retained-memory measurement. Run only at merge under owner policy.
const sessions = z.coerce
  .number()
  .int()
  .min(100)
  .max(10_000)
  .parse(process.argv[2] ?? 1000);
const directory = await mkdtemp(join(tmpdir(), "ace-review-memory-"));
const root = join(directory, "repo");
await mkdir(root);
const exec = (...args: string[]) => promisify(execFile)("git", args, { cwd: root });
await exec("init", "-q");
await exec("config", "user.name", "Review benchmark");
await exec("config", "user.email", "benchmark@example.invalid");
await writeFile(join(root, "file.ts"), "before\noriginal\nafter\n");
await exec("add", ".");
await exec("commit", "-qm", "base");
await writeFile(join(root, "file.ts"), "before\nchanged\nafter\n");
const git = new GitService();
let ids = 0;
const service = new ReviewService({
  path: join(directory, "reviews.sqlite"),
  git,
  now: Date.now,
  id: () => `session-${++ids}`,
});
const samples: { sessions: number; rssMiB: number; checkpointCounters: number }[] = [];
const start = performance.now();
try {
  for (let n = 0; n < sessions; n++) {
    const result = await service.handle(
      Command.parse({
        id: `open-${n}`,
        deviceId: "benchmark",
        payload: {
          type: "review.open",
          source: {
            workspaceId: "benchmark",
            from: { kind: "commit", ref: "HEAD" },
            to: { kind: "working-tree" },
          },
        },
      }),
      root,
    );
    if (!result.ok) throw new Error(result.error);
    if ((n + 1) % 50 === 0)
      samples.push({
        sessions: n + 1,
        rssMiB: process.memoryUsage().rss / 1024 ** 2,
        checkpointCounters: git.resourceUsage().checkpointCounters,
      });
  }
  const milliseconds = performance.now() - start;
  console.log(
    JSON.stringify({
      sessions,
      sessionsPerSecond: (sessions * 1000) / milliseconds,
      microsecondsPerSession: (milliseconds * 1000) / sessions,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
      samples,
    }),
  );
} finally {
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
