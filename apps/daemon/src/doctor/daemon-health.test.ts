import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Client } from "@ace/client";
import { CommandResult, type DiagnosticsHealth } from "@ace/protocol";
import type { DoctorContext } from "./feature.ts";
import { daemonHealth } from "./daemon-health.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function health(overrides: Partial<DiagnosticsHealth> = {}): DiagnosticsHealth {
  return {
    at: NOW,
    eventLoop: { meanMs: 1.2, p99Ms: 8, maxMs: 40 },
    memory: {
      rssBytes: 300 * 1024 ** 2,
      heapUsedBytes: 90 * 1024 ** 2,
      heapTotalBytes: 140 * 1024 ** 2,
    },
    openHandles: 120,
    sqlite: { pageBytes: 1024, walBytes: 0 },
    activeSessions: 2,
    queues: { "engine.frames": 0, "engine.queuedSends": 1, "daemon.socketInput": 0 },
    logs: { dropped: 0, failed: 0, queued: 0 },
    ...overrides,
  };
}

/** A running daemon whose only answer is `reply` to the health command. */
function answering(reply: () => Promise<CommandResult>): DoctorContext["daemon"] {
  const client: Client = Object.create(Client.prototype);
  client.command = reply;
  return async (use) => use(client, new AbortController().signal);
}
const healthy = (report: DiagnosticsHealth) =>
  answering(async () => CommandResult.parse({ commandId: "c1", ok: true, health: report }));

async function setup(
  overrides: Partial<DoctorContext>,
  files: { run?: object; shutdown?: object; log?: object[] },
) {
  const { context, dataDir, cleanup } = await doctorTestContext({ now: () => NOW, ...overrides });
  cleanups.push(cleanup);
  if (files.run) await writeFile(join(dataDir, "daemon-run.json"), JSON.stringify(files.run));
  if (files.shutdown)
    await writeFile(join(dataDir, "daemon-shutdown.json"), JSON.stringify(files.shutdown));
  if (files.log) {
    await mkdir(join(dataDir, "logs"));
    await writeFile(
      join(dataDir, "logs", "ace.jsonl"),
      files.log.map((entry) => JSON.stringify(entry)).join("\n"),
    );
  }
  return context;
}

async function runAll(context: DoctorContext) {
  const signal = new AbortController().signal;
  const checks = daemonHealth.checks(context);
  return Object.fromEntries(
    await Promise.all(checks.map(async (check) => [check.id, await check.run(signal)] as const)),
  );
}

const listening = (at: number, pid: number, version: string) => ({
  at,
  level: "info",
  component: "ace",
  message: "Daemon listening",
  data: { url: "http://127.0.0.1:7000", pid, version, dataFormat: "v15" },
});

it("a running daemon that answers passes every check and names its version and uptime", async () => {
  const context = await setup(
    { daemonState: "running", daemon: healthy(health()) },
    {
      run: { state: "running", pid: 4242, startedAt: NOW - 3 * 3_600_000 },
      log: [listening(NOW - 3 * 3_600_000, 4242, "1.4.0")],
    },
  );
  const results = await runAll(context);
  expect(Object.keys(results)).toEqual([
    "daemon.state",
    "daemon.responsiveness",
    "daemon.memory",
    "daemon.queues",
    "daemon.logging",
  ]);
  for (const result of Object.values(results)) expect(result.status).toBe("ok");
  expect(results["daemon.state"]?.message).toBe(
    "Running and answering: pid 4242, version 1.4.0, up 3 h, 2 active sessions",
  );
  expect(results["daemon.queues"]?.message).toBe("Waiting: 1 queued message");
});

it("a daemon that is running but never answers fails once, without a warning per metric", async () => {
  const context = await setup(
    { daemonState: "running", platform: "darwin", daemon: async () => undefined },
    { run: { state: "running", pid: 4242, startedAt: NOW - 20 * MINUTE } },
  );
  const results = await runAll(context);
  const state = results["daemon.state"];
  expect(state?.status).toBe("fail");
  expect(state?.message).toContain("pid 4242");
  expect(state?.message).toContain("not answering");
  expect(state?.fix).toContain("kill 4242");
  const problems = Object.entries(results).filter(([, result]) => result.status !== "ok");
  expect(problems.map(([id]) => id)).toEqual(["daemon.state"]);
});

it("a health request that times out after connecting reads as not answering", async () => {
  const timeout = Object.assign(new Error("Request timed out"), { code: "timeout" });
  const context = await setup(
    {
      daemonState: "running",
      daemon: answering(async () => {
        throw timeout;
      }),
    },
    { run: { state: "running", pid: 4242, startedAt: NOW - 20 * MINUTE } },
  );
  expect((await runAll(context))["daemon.state"]?.status).toBe("fail");
});

it("a daemon that started seconds ago and doesn't answer yet is only a warning", async () => {
  const context = await setup(
    { daemonState: "running", daemon: async () => undefined },
    { run: { state: "running", pid: 4242, startedAt: NOW - 10_000 } },
  );
  const state = (await runAll(context))["daemon.state"];
  expect(state?.status).toBe("warn");
  expect(state?.message).toContain("may still be starting");
});

it("a daemon that crashed says so and surfaces its last fatal error", async () => {
  const startedAt = NOW - 2 * 3_600_000;
  const context = await setup(
    {},
    {
      // The run file still says running, but the probe found the process gone.
      run: { state: "running", pid: 4242, startedAt },
      log: [
        listening(startedAt, 4242, "1.4.0"),
        {
          at: NOW - 30 * MINUTE,
          level: "error",
          component: "ace",
          message: "Fatal error",
          data: { error: { message: "SQLITE_FULL: database or disk is full" } },
        },
      ],
    },
  );
  const results = await runAll(context);
  expect(Object.keys(results)).toEqual(["daemon.state"]);
  const state = results["daemon.state"];
  expect(state?.status).toBe("warn");
  expect(state?.message).toContain("crashed or was killed");
  expect(state?.message).toContain("30 min ago: SQLITE_FULL: database or disk is full");
});

it("a daemon whose last start failed fails with that start's error", async () => {
  const context = await setup(
    {},
    {
      run: {
        state: "stopped",
        pid: 4300,
        startedAt: NOW - 5 * MINUTE - 500,
        stoppedAt: NOW - 5 * MINUTE + 200,
        source: "startup-failure",
      },
      log: [
        listening(NOW - 3 * 3_600_000, 4242, "1.4.0"),
        {
          at: NOW - 5 * MINUTE,
          level: "error",
          component: "ace",
          message: "Daemon startup failed",
          data: { error: { message: "EADDRINUSE: port 7000 is taken" }, pid: 4300 },
        },
      ],
    },
  );
  const state = (await runAll(context))["daemon.state"];
  expect(state?.status).toBe("fail");
  expect(state?.message).toBe(
    "Not running. Its last start, 5 min ago, failed: EADDRINUSE: port 7000 is taken",
  );
});

it("a start refused for newer data tells the person to update ace", async () => {
  const context = await setup(
    {},
    {
      run: {
        state: "stopped",
        pid: 4242,
        startedAt: NOW - 3 * 3_600_000,
        stoppedAt: NOW - 3_600_000,
        source: "signal",
        signal: "SIGTERM",
      },
      log: [
        {
          at: NOW - MINUTE,
          level: "error",
          component: "ace",
          message:
            "This ace build is older than the data in ~/.ace: data format v16, build supports v15.",
          data: { storedFormat: "v16", pid: 4400 },
        },
      ],
    },
  );
  const state = (await runAll(context))["daemon.state"];
  expect(state?.status).toBe("fail");
  expect(state?.message).toContain("This ace build is older than the data");
  expect(state?.fix).toContain("update");
});

it("a daemon stopped by a signal says which, and a failed ace stop is mentioned", async () => {
  const context = await setup(
    {},
    {
      run: {
        state: "stopped",
        pid: 4242,
        startedAt: NOW - 3 * 3_600_000,
        stoppedAt: NOW - 10 * MINUTE,
        source: "signal",
        signal: "SIGTERM",
        overran: ["event store"],
      },
      shutdown: { id: "r1", state: "failed", at: NOW - 10 * MINUTE, error: "deadline" },
    },
  );
  const state = (await runAll(context))["daemon.state"];
  expect(state?.status).toBe("warn");
  expect(state?.message).toContain("stopped 10 min ago on SIGTERM");
  expect(state?.message).toContain("still closing: event store");
  expect(state?.message).toContain("cleanup failed");
});

it("a daemon that was quit cleanly is not a warning, so doctor doesn't nag after closing ace", async () => {
  const context = await setup(
    {},
    {
      run: {
        state: "stopped",
        pid: 4242,
        startedAt: NOW - 3 * 3_600_000,
        stoppedAt: NOW - 10 * MINUTE,
        source: "signal",
        signal: "SIGTERM",
      },
      shutdown: { id: "r1", state: "succeeded", at: NOW - 10 * MINUTE },
    },
  );
  const state = (await runAll(context))["daemon.state"];
  expect(state?.status).toBe("ok");
  expect(state?.message).toContain("stopped 10 min ago on SIGTERM");
});

it("an event-loop stall and a provider-output backlog past their thresholds warn", async () => {
  const context = await setup(
    {
      daemonState: "running",
      daemon: healthy(
        health({
          eventLoop: { meanMs: 40, p99Ms: 400, maxMs: 900 },
          queues: { "engine.frames": 5000, "engine.queuedSends": 3 },
        }),
      ),
    },
    { run: { state: "running", pid: 4242, startedAt: NOW - 3_600_000 } },
  );
  const results = await runAll(context);
  expect(results["daemon.state"]?.status).toBe("ok");
  expect(results["daemon.responsiveness"]?.status).toBe("warn");
  expect(results["daemon.responsiveness"]?.message).toContain("p99 400.0 ms");
  expect(results["daemon.queues"]?.status).toBe("warn");
  expect(results["daemon.queues"]?.message).toBe(
    "Work is piling up: 5000 provider output frames waiting",
  );
  expect(results["daemon.memory"]?.status).toBe("ok");
});

it("failed log writes warn and point at the log folder", async () => {
  const context = await setup(
    {
      daemonState: "running",
      daemon: healthy(
        health({ logs: { dropped: 3, failed: 12, queued: 0, directory: "/tmp/ace/logs" } }),
      ),
    },
    { run: { state: "running", pid: 4242, startedAt: NOW - 3_600_000 } },
  );
  const logging = (await runAll(context))["daemon.logging"];
  expect(logging?.status).toBe("warn");
  expect(logging?.message).toContain("12 log writes failed");
  expect(logging?.fix).toContain("/tmp/ace/logs");
});
