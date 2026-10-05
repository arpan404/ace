import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { liveWorkerTelemetry } from "@ace/perf-kit";

const run = promisify(execFile);

test("retired isolates are excluded even when a caller retains their old samples", async () => {
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
          import { readWorkerSnapshot } from '@ace/perf-kit';
          import { z } from 'zod';
          const code = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('ready'); setInterval(() => {}, 1000)";
          const workers = [new Worker(new URL('data:text/javascript,' + encodeURIComponent(code))), new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)))];
          await Promise.all(workers.map(worker => once(worker, 'message')));
          const [retired, live] = workers;
          const retiredId = retired.threadId;
          const schema = z.object({threadId:z.number().int().nonnegative(),workerIds:z.array(z.number().int().positive()),pendingWorkerIds:z.array(z.number().int().positive()),generation:z.number().int().nonnegative()});
          const read = id => schema.parse(JSON.parse(readFileSync(join(process.env.ACE_PERF_TELEMETRY, id + '.json'), 'utf8')));
          const snapshot = () => readWorkerSnapshot({read: async id=>read(id), now:()=>performance.now(), pause:()=>new Promise(r=>setTimeout(r,10)), timeoutMs:4000});
          await snapshot();
          const retiredSample = read(retiredId);
          await retired.terminate();
          console.log(JSON.stringify({ main: read(0), retired: retiredSample, live: read(live.threadId) }));
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

test("sampling waits for worker initialization and follows retirement during file reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-telemetry-churn-"));
  const preload = join(import.meta.dirname, "../bench/telemetry.mjs");
  const delayed = join(directory, "delay.mjs");
  await writeFile(
    delayed,
    `await new Promise(resolve => setTimeout(resolve, 150)); await import(${JSON.stringify(new URL("../bench/telemetry.mjs", import.meta.url).href)});`,
  );
  try {
    const { stdout } = await run(
      process.execPath,
      [
        "--import",
        preload,
        "--input-type=module",
        "-e",
        `
      import { Worker } from 'node:worker_threads';
      import { once } from 'node:events';
      import { readFile, readdir } from 'node:fs/promises';
      import { join } from 'node:path';
      import { z } from 'zod';
      import { readWorkerSnapshot } from '@ace/perf-kit';
      const directory = process.env.ACE_PERF_TELEMETRY;
      const schema = z.object({threadId:z.number(),workerIds:z.array(z.number()),pendingWorkerIds:z.array(z.number()),generation:z.number()});
      const read = async id => schema.parse(JSON.parse(await readFile(join(directory, id+'.json'), 'utf8')));
      const sample = readOverride => readWorkerSnapshot({
        read: readOverride ?? read, now: () => performance.now(),
        pause: () => new Promise(resolve => setTimeout(resolve, 10)), timeoutMs: 4000,
      });
      const code = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('ready'); setInterval(() => {}, 1000)";
      const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)), { execArgv:['--import',${JSON.stringify(delayed)}] });
      const id = worker.threadId;
      const ready = once(worker, 'message');
      const starting = await sample();
      await ready;
      let retired = false;
      const ending = await sample(async requested => {
        const data = await read(requested);
        if (requested === 0 && !retired) { retired = true; await worker.terminate(); }
        return data;
      });
      for(let n=0;n<8;n++) {
        const transient = new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)));
        const snapshot = await sample();
        if (!snapshot.workers.some(w=>w.threadId===transient.threadId)) throw Error('lost live worker');
        await transient.terminate();
      }
      console.log(JSON.stringify({starting:starting.workers.map(w=>w.threadId),id,ending:ending.workers.length,files:(await readdir(directory)).filter(f=>f.endsWith('.json'))}));
    `,
      ],
      {
        cwd: import.meta.dirname,
        env: { ...process.env, ACE_PERF_TELEMETRY: directory },
        timeout: 10_000,
      },
    );
    const data = z
      .object({
        starting: z.array(z.number()),
        id: z.number(),
        ending: z.number(),
        files: z.array(z.string()),
      })
      .parse(JSON.parse(stdout));
    expect(data.starting).toEqual([data.id]);
    expect(data.ending).toBe(0);
    expect(data.files).toEqual(["0.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
