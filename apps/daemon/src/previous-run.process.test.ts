import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchDaemon } from "./process-test-support.ts";
import { daemonLogRecords, type DaemonLogRecord } from "./daemon-log-test-support.ts";

const ending = /^(No previous daemon run|Previous daemon run)/;

test("the next start says whether the last daemon run stopped in order or was killed", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-previous-run-"));
  const cleanups: (() => Promise<void> | void)[] = [
    () => rm(home, { recursive: true, force: true }),
  ];
  onTestFinished(async () => {
    for (const close of cleanups.toReversed()) await close();
  });
  const env = { ...process.env, ACE_HOME: home, ACE_PORT: "0", ACE_LISTEN: "local", PATH: "" };
  const endings = async (): Promise<DaemonLogRecord[]> =>
    (await daemonLogRecords(home)).filter((record) => ending.test(record.message));

  const first = launchDaemon(env, /Token file:/, cleanups);
  await first.ready;
  expect(await endings()).toMatchObject([{ message: "No previous daemon run recorded" }]);
  // An app quit or update: SIGTERM and an orderly shutdown.
  first.child.kill("SIGTERM");
  expect((await first.exited)[0]).toBe(0);

  const second = launchDaemon(env, /Token file:/, cleanups);
  await second.ready;
  expect((await endings()).at(-1)).toMatchObject({
    level: "info",
    message: "Previous daemon run stopped in order",
    data: { previousPid: first.child.pid, previousSource: "signal", previousSignal: "SIGTERM" },
  });
  // A crash: the process dies without running any shutdown.
  second.child.kill("SIGKILL");
  await second.exited;

  const third = launchDaemon(env, /Token file:/, cleanups);
  await third.ready;
  expect((await endings()).at(-1)).toMatchObject({
    level: "warn",
    message: "Previous daemon run ended without stopping: it crashed or was killed",
    data: { previousPid: second.child.pid },
  });
  third.child.kill("SIGTERM");
  expect((await third.exited)[0]).toBe(0);
}, 120_000);
