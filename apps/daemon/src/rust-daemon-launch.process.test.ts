import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { accessRequest } from "./client-access.ts";
import { invoke } from "./cli-test-support.ts";
import {
  lastRunEnding,
  startDaemonCli,
  temporaryHome,
  walBytes,
  type Cleanups,
} from "./daemon-launch-test-support.ts";

/*
 * The daemon as a program, started through `daemon-launch-test-support.ts`:
 * with `ACE_TEST_DAEMON_BINARY` set it launches `ace-daemon-bin` instead of the
 * TypeScript CLI. The cases are the platform-independent half of
 * `daemon-stop-restart.process.test.ts`: start, status, the single-instance
 * refusal, a stop through the real CLI, and a crash the next start reports.
 * Skipped unless the env var names the binary, so an ordinary run pays nothing.
 */
const binary = process.env.ACE_TEST_DAEMON_BINARY;

async function publicFiles(home: string) {
  const [origin, token, hostId] = await Promise.all(
    ["daemon-endpoint", "daemon-token", "host-id"].map((name) =>
      readFile(join(home, name), "utf8"),
    ),
  );
  return { origin: origin ?? "", token: token ?? "", hostId: hostId ?? "" };
}

async function stopThroughCli(home: string) {
  const stop = await invoke(home, ["stop", "--json", "--timeout", "60s"]);
  expect(stop.code, stop.stderr).toBe(0);
  expect(JSON.parse(stop.stdout)).toMatchObject({ stopped: true });
}

test.runIf(binary)(
  "the Rust daemon starts, refuses a rival, and stops through the CLI in order",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-rust-stop-", cleanups);
    const first = startDaemonCli(home, cleanups);
    await first.ready;
    const before = await publicFiles(home);
    expect(await accessRequest(before.origin, "/v1/status", { token: before.token })).toMatchObject(
      { running: true, ready: true },
    );

    const rival = startDaemonCli(home, cleanups);
    await expect(rival.ready).rejects.toThrow("Another daemon owns it");
    expect(await rival.exited).not.toBe(0);
    expect(await publicFiles(home)).toEqual(before);

    await stopThroughCli(home);
    expect(await first.exited).toBe(0);
    expect(await walBytes(join(home, "events.sqlite"))).toBe(0);

    const second = startDaemonCli(home, cleanups);
    await second.ready;
    const after = await publicFiles(home);
    expect(after.token).toBe(before.token);
    expect(after.hostId).toBe(before.hostId);
    expect(await accessRequest(after.origin, "/v1/status", { token: after.token })).toMatchObject({
      running: true,
    });
    expect(await lastRunEnding(home)).toMatchObject({
      level: "info",
      message: "Previous daemon run stopped in order",
      data: { previousPid: first.child.pid, previousSource: "stop-request" },
    });
    await stopThroughCli(home);
    expect(await second.exited).toBe(0);
  },
  180_000,
);

test.runIf(binary)(
  "a Rust daemon killed while holding the lock leaves none, and the next start reports the crash",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-rust-crash-", cleanups);
    const first = startDaemonCli(home, cleanups);
    await first.ready;
    const before = await publicFiles(home);
    first.child.kill("SIGKILL");
    await first.exited;

    const second = startDaemonCli(home, cleanups);
    await second.ready;
    const after = await publicFiles(home);
    expect(after.token).toBe(before.token);
    expect(after.hostId).toBe(before.hostId);
    expect(await accessRequest(after.origin, "/v1/status", { token: after.token })).toMatchObject({
      running: true,
    });
    expect(await lastRunEnding(home)).toMatchObject({
      level: "warn",
      message: "Previous daemon run ended without stopping: it crashed or was killed",
      data: { previousPid: first.child.pid },
    });
    await stopThroughCli(home);
    expect(await second.exited).toBe(0);
  },
  180_000,
);
