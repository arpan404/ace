import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { liveWorkerTelemetry } from "@ace/perf-kit";

const run = promisify(execFile);

test("retired isolates are excluded while their telemetry files still exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-telemetry-test-"));
  try {
    const { stdout } = await run(
      process.execPath,
      [
        "--import",
        join(import.meta.dirname, "../bench/telemetry.mjs"),
        "--input-type=module",
        "-e",
        `
          import { Worker } from 'node:worker_threads';
          import { once } from 'node:events';
          import { readFileSync } from 'node:fs';
          import { join } from 'node:path';
          const code = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('ready'); setInterval(() => {}, 1000)";
          const workers = [new Worker(code, { eval: true }), new Worker(code, { eval: true })];
          await Promise.all(workers.map(worker => once(worker, 'message')));
          const [retired, live] = workers;
          const retiredId = retired.threadId;
          await retired.terminate();
          const read = id => JSON.parse(readFileSync(join(process.env.ACE_PERF_TELEMETRY, id + '.json'), 'utf8'));
          console.log(JSON.stringify({ main: read(0), retired: read(retiredId), live: read(live.threadId) }));
          await live.terminate();
        `,
      ],
      { env: { ...process.env, ACE_PERF_TELEMETRY: directory }, timeout: 10_000 },
    );
    const isolate = z.object({ threadId: z.number(), workerIds: z.array(z.number()) });
    const data = z
      .object({ main: isolate, retired: isolate, live: isolate })
      .parse(JSON.parse(stdout));
    const sample = liveWorkerTelemetry([data.main, data.retired, data.live]);
    expect(sample.workers.map((worker) => worker.threadId)).toEqual([data.live.threadId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
