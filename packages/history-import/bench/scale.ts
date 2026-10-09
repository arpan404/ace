import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { writeHeapSnapshot } from "node:v8";
import { z } from "zod";
const Memory = z.object({ heapUsed: z.number(), rss: z.number() });
import { openHistory } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "ace-history-scale-"));
let service;
let isolate: Worker | undefined;
try {
  await promisify(execFile)(process.execPath, [
    new URL("./generate-scale.ts", import.meta.url).pathname,
    root,
  ]);
  const trace = join(root, "worker-heap.jsonl");
  const fixture = {
    cwd: "/synthetic/project",
    instances: (["opencode", "codex", "claude"] as const).map((provider) => ({
      id: provider,
      provider,
      homeDir: join(root, provider),
    })),
  };
  console.log(JSON.stringify({ phase: "fixture", rssMiB: process.memoryUsage().rss / 1048576 }));
  service = await openHistory(
    { indexPath: join(root, "ace/index.sqlite"), instances: fixture.instances },
    (url, options) => {
      isolate = new Worker(url, {
        ...options,
        execArgv: [
          ...process.execArgv,
          "--import",
          new URL("./heap-trace.mjs", import.meta.url).href,
        ],
        env: { ...process.env, ACE_HISTORY_HEAP_TRACE: trace },
      });
      return isolate;
    },
  );
  for (const label of ["cold", "warm"]) {
    const start = performance.now();
    const result = await service.scan();
    console.log(
      JSON.stringify({
        phase: label,
        ms: performance.now() - start,
        ...result,
        rssMiB: process.memoryUsage().rss / 1048576,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
      }),
    );
  }
  const page = await service.list({ type: "history.list", cwd: fixture.cwd, limit: 4 });
  console.log(JSON.stringify({ phase: "listed", titles: page.sessions.map((s) => s.title) }));
  if (process.argv.includes("--snapshot")) {
    if (isolate)
      await pipeline(
        await isolate.getHeapSnapshot(),
        createWriteStream("/tmp/ace-history-worker.heapsnapshot"),
      );
    console.log(writeHeapSnapshot("/tmp/ace-history-before.heapsnapshot"));
  }
  const samples = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => Memory.parse(JSON.parse(line)));
  console.log(
    JSON.stringify({
      phase: "worker-peak",
      heapMiB: Math.max(...samples.map((s) => s.heapUsed)) / 1048576,
      rssMiB: Math.max(...samples.map((s) => s.rss)) / 1048576,
    }),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 120000));
  const idleRssMiB = process.memoryUsage().rss / 1048576;
  console.log(JSON.stringify({ phase: "idle", rssMiB: idleRssMiB }));

  if (idleRssMiB > 256) throw new Error("History idle RSS exceeds 256 MiB");
} finally {
  await service?.close();
  await rm(root, { recursive: true, force: true });
}
