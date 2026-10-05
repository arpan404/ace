import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  retryTiming,
  TimingFailure,
  runTimed,
  checkBudgets,
  readFreshMeasurement,
  stopProcess,
} from "@ace/perf-kit";

const run = promisify(execFile);

test("cyclic worker ownership fails instead of producing a valid process sample", async () => {
  await expect(
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { liveWorkerTelemetry } from '@ace/perf-kit';
    liveWorkerTelemetry([{threadId:0,workerIds:[1]},{threadId:1,workerIds:[0]}]);
  `,
      ],
      { cwd: import.meta.dirname, timeout: 2000 },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Invalid worker telemetry tree"),
  });
});

test.each(["schema", "shutdown", "acceptance"])(
  "%s failure remains fatal when real subprocess cleanup crosses its deadline",
  async (kind) => {
    const diagnostics: string[] = [];
    const source = `
      import { measureWithCleanup } from '@ace/perf-kit';
      import { writeSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      import { z } from 'zod';
      import { strict as assert } from 'node:assert';
      await measureWithCleanup(
        async () => {
          ${
            kind === "schema"
              ? `
            const child = spawn(process.execPath,['-e','process.send({ok:false})'],{stdio:['ignore','ignore','ignore','ipc']});
            const exited = once(child,'exit');
            const [input] = await once(child,'message');
            await exited;
            z.object({ok:z.literal(true)}).parse(input);
          `
              : kind === "shutdown"
                ? `
            const child=spawn(process.execPath,['-e','process.exit(7)']);
            const [code]=await once(child,'exit');
            if(code!==0) throw new Error('Shutdown failed: '+code);
          `
                : "assert.equal(1,2,'acceptance assertion failed');"
          }
        },
        async () => { await new Promise(resolve => setTimeout(resolve, 5000)); },
        marker => writeSync(2, marker + '\\n'),
      );
    `;
    const result = retryTiming(
      () =>
        runTimed(run, process.execPath, ["--input-type=module", "-e", source], {
          cwd: import.meta.dirname,
          timeout: 2000,
        }),
      (error) => diagnostics.push(error.message),
    );
    await expect(result).rejects.not.toBeInstanceOf(TimingFailure);
    await expect(result).rejects.toMatchObject({
      killed: true,
      stderr: expect.stringContaining('"type":"measurement.failed"'),
    });
    expect(diagnostics).toEqual([]);
  },
);

test("legacy acceptance assertions cannot become timing retries during cleanup", async () => {
  await expect(
    runTimed(
      run,
      process.execPath,
      [
        "-e",
        `
    require('node:fs').writeSync(2, JSON.stringify({type:'acceptance.failed'})+'\\n');
    setInterval(() => {}, 1000);
  `,
      ],
      { cwd: import.meta.dirname, timeout: 2000 },
    ),
  ).rejects.not.toBeInstanceOf(TimingFailure);
});

test("output overflow fails immediately even though it kills the subprocess", async () => {
  const diagnostics: string[] = [];
  const result = retryTiming(
    () =>
      runTimed(run, process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], {
        cwd: import.meta.dirname,
        timeout: 2000,
        maxBuffer: 1024,
      }),
    (error) => diagnostics.push(error.message),
  );
  await expect(result).rejects.not.toBeInstanceOf(TimingFailure);
  await expect(result).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  expect(diagnostics).toEqual([]);
});

test("resource violations take precedence over timing violations and cleanup deadlines", async () => {
  const diagnostics: string[] = [];
  await expect(
    retryTiming(
      async () => {
        checkBudgets(
          ["RSS exceeds budget"],
          ["throughput below floor"],
          new TimingFailure("deadline"),
        );
      },
      (error) => diagnostics.push(error.message),
    ),
  ).rejects.toThrow("RSS exceeds budget");
  expect(diagnostics).toEqual([]);
});

test.each(["deadline", "empty"])(
  "an incomplete %s repeat cannot reuse previous passing output",
  async (ending) => {
    const directory = await mkdtemp(join(tmpdir(), "ace-fresh-result-"));
    const output = join(directory, "result.json");
    let attempt = 0;
    try {
      await expect(
        retryTiming(
          async () => {
            const current = ++attempt;
            const result = await readFreshMeasurement(output, async () => {
              const source =
                current === 1
                  ? `require('node:fs').writeFileSync(${JSON.stringify(output)}, '{"ok":true}'); setInterval(() => {},1000);`
                  : ending === "deadline"
                    ? "setInterval(() => {},1000);"
                    : "process.exit(0)";
              await runTimed(run, process.execPath, ["-e", source], {
                cwd: import.meta.dirname,
                timeout: 2000,
              });
            });
            z.object({ ok: z.literal(true) }).parse(JSON.parse(result.raw));
            checkBudgets([], [], result.deadline);
            return "passed";
          },
          () => {},
        ),
      ).rejects.toThrow(ending === "deadline" ? "deadline" : "ENOENT");
      await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a real deadline retains its first diagnostic and can accept one complete repeat", async () => {
  const diagnostics: string[] = [];
  const output: string[] = [];
  let attempt = 0;
  const result = await retryTiming(
    () =>
      runTimed(
        run,
        process.execPath,
        [
          "-e",
          ++attempt === 1
            ? "console.log('first sample'); setInterval(() => {},1000);"
            : "console.log('390 events/s')",
        ],
        { cwd: import.meta.dirname, timeout: 2000 },
        (stdout) => output.push(stdout),
      ),
    (error) => diagnostics.push(error.message),
  );
  expect(result.stdout.trim()).toBe("390 events/s");
  expect(output.join("")).toContain("first sample");
  expect(diagnostics).toEqual(["subprocess exceeded its 2000 ms deadline"]);
});

test("preview cleanup waits for exit and releases its listening port before returning", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const server=require('node:http').createServer((req,res)=>res.end('preview'));
    process.on('SIGTERM', () => setTimeout(() => server.close(()=>process.exit(0)), 100));
    server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
  `,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, "line");
    const port = z.coerce.number().int().min(1).max(65535).parse(line);
    await stopProcess(child);
    expect(child.exitCode).toBe(0);
    const replacement = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        replacement.once("error", reject);
        replacement.listen(port, "127.0.0.1", resolve);
      });
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
    }
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
});
