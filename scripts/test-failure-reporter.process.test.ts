import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";

const repository = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const Report = z.object({
  failure: z.string(),
  project: z.string(),
  file: z.string(),
  errors: z.array(z.record(z.string(), z.unknown())),
});

test("real failed tests report nested cleanup causes with bounded output and retain their failure status", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-failure-reporter-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await symlink(join(repository, "node_modules"), join(root, "node_modules"), "junction");
  const fixture = join(root, "failures.test.ts");
  const config = join(root, "vitest.config.mjs");
  await writeFile(
    fixture,
    `
    import {test, expect, afterEach} from 'vitest';
    let cleanup;
    afterEach(() => {const close = cleanup; cleanup = undefined; close?.()});
    test('passing test', () => expect(1).toBe(1));
    test('ordinary assertion', () => expect('actual').toBe('expected'));
    test('nested cleanup', () => {
      const resource = new Error('registry close rejected', {cause:new Error('sqlite busy')});
      cleanup = () => {throw new AggregateError([new AggregateError([new AggregateError([resource], 'Files cleanup failed')], 'Daemon resource cleanup failed')], 'Daemon resource cleanup failed')};
    });
    test('bounded aggregate', () => {
      const nested = depth => depth === 0 ? new Error('leaf') : new AggregateError(Array.from({length:12}, () => nested(depth - 1)), 'x'.repeat(20000));
      throw nested(3);
    });
  `,
  );
  await writeFile(
    config,
    `
    import {FailureDetailsReporter} from ${JSON.stringify(new URL("./test-failure-reporter.ts", import.meta.url).href)};
    export default {root:${JSON.stringify(root)},test:{include:['failures.test.ts'],maxWorkers:1,reporters:[new FailureDetailsReporter()]}};
  `,
  );
  const execution = execute(
    process.execPath,
    [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--config", config],
    {
      cwd: repository,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: PROCESS_TEST_TIMEOUT,
    },
  );
  onTestFinished(async () => {
    if (execution.child.exitCode === null && execution.child.signalCode === null)
      execution.child.kill("SIGTERM");
    await execution.catch(() => {});
  });
  let failure: unknown;
  try {
    await execution;
  } catch (error) {
    failure = error;
  }
  const output = z
    .object({ code: z.literal(1), stderr: z.string(), stdout: z.string() })
    .parse(failure);
  const reports = output.stderr
    .split("\n")
    .filter((line) => line.startsWith('{"failure":'))
    .map((line) => Report.parse(JSON.parse(line)));
  expect(reports).toHaveLength(3);
  const ordinary = reports.find((report) => report.failure === "ordinary assertion");
  expect(ordinary?.errors[0]).toMatchObject({
    name: "AssertionError",
    message: expect.stringContaining("expected"),
  });
  expect(ordinary?.errors[0]?.stack).toEqual(expect.any(String));
  expect(reports.find((report) => report.failure === "nested cleanup")?.errors[0]).toMatchObject({
    message: "Daemon resource cleanup failed",
    errors: [
      {
        message: "Files cleanup failed",
        errors: [{ message: "registry close rejected", cause: { message: "sqlite busy" } }],
      },
    ],
  });
  const bounded = reports.find((report) => report.failure === "bounded aggregate");
  expect(bounded?.errors[0]?.message).toHaveLength(8_000);
  expect(bounded?.errors[0]?.omittedErrors).toBe(8);
  expect(JSON.stringify(bounded)).toContain('"truncated":"capacity"');
  expect(JSON.stringify(bounded).length).toBeLessThan(800_000);
});
