import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { accessRequest } from "./client-access.ts";
import { invoke } from "./cli-test-support.ts";
import { daemonInConsole } from "./console-control-test-support.ts";
import {
  lastRunEnding,
  startDaemonCli,
  temporaryHome,
  walBytes,
  type Cleanups,
} from "./daemon-launch-test-support.ts";

const windows = process.platform === "win32";

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

test.runIf(windows)(
  "Windows: ace stop ends the daemon in order, a second daemon on the same home refuses, and restart keeps token and host id",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-win-stop-", cleanups);
    const first = startDaemonCli(home, cleanups);
    await first.ready;
    const before = await publicFiles(home);

    const rival = startDaemonCli(home, cleanups);
    await expect(rival.ready).rejects.toThrow("Another daemon owns it");
    expect(await rival.exited).not.toBe(0);
    // The refused start left the running daemon and its published files alone.
    expect(await publicFiles(home)).toEqual(before);
    expect(await accessRequest(before.origin, "/v1/status", { token: before.token })).toMatchObject(
      { running: true },
    );

    await stopThroughCli(home);
    expect(await first.exited).toBe(0);
    // Close drained every store writer and checkpointed the event log.
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

test.runIf(windows)(
  "Windows: a daemon ended by TerminateProcess leaves no stale lock, and the restart reports the crash",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-win-crash-", cleanups);
    const first = startDaemonCli(home, cleanups);
    await first.ready;
    const before = await publicFiles(home);
    // Node maps kill() to TerminateProcess on Windows: no handler or finalizer runs.
    first.child.kill();
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

for (const [name, event] of [
  ["Ctrl+C", "c"],
  ["Ctrl+Break", "break"],
] as const)
  test.runIf(windows)(
    `Windows: ${name} delivered to the daemon's console stops it in order`,
    async ({ onTestFinished }) => {
      const cleanups: Cleanups = [];
      onTestFinished(async () => {
        for (const close of cleanups.toReversed()) await close();
      });
      const home = await temporaryHome(`ace-win-console-${event}-`, cleanups);
      const outcome = await daemonInConsole(home, { event, when: "ready" }, cleanups);
      expect(outcome, outcome.errors).toMatchObject({ code: 0, sawReady: true, sent: true });
      expect(await walBytes(join(home, "events.sqlite"))).toBe(0);

      const next = startDaemonCli(home, cleanups);
      await next.ready;
      expect(await lastRunEnding(home)).toMatchObject({
        level: "info",
        message: "Previous daemon run stopped in order",
        data: { previousPid: outcome.pid, previousSource: "signal" },
      });
      await stopThroughCli(home);
      expect(await next.exited).toBe(0);
    },
    180_000,
  );

test.runIf(windows)(
  "Windows: Ctrl+Break while the daemon is still starting stops it without publishing readiness, and the next start succeeds",
  async ({ onTestFinished }) => {
    const cleanups: Cleanups = [];
    onTestFinished(async () => {
      for (const close of cleanups.toReversed()) await close();
    });
    const home = await temporaryHome("ace-win-console-starting-", cleanups);
    const outcome = await daemonInConsole(home, { event: "break", when: "starting" }, cleanups);
    expect(outcome, outcome.errors).toMatchObject({ code: 0, sawReady: false, sent: true });

    const next = startDaemonCli(home, cleanups);
    await next.ready;
    expect((await lastRunEnding(home))?.message).not.toMatch(/crashed/);
    await stopThroughCli(home);
    expect(await next.exited).toBe(0);
  },
  180_000,
);
