import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EscapeeJournal } from "@ace/provider-kit/escapee-journal";
import { processIdentity } from "@ace/provider-kit/process-identity";
import { PROCESS_OWNER_ENV } from "@ace/provider-kit/process-marker";
import { prepareDaemonHome } from "@ace/service";
import { afterEach, expect, test } from "vitest";
import { invoke } from "./cli-test-support.ts";

/*
 * `ace stop` and a daemon's start against a real daemon whose provider left processes behind,
 * with an offline fake Codex on PATH:
 * - a turn's app-server, with one child in its process group and one in a session of its own
 *   that holds the app-server's stdout and stderr, as a shell a real agent backgrounds can;
 * - a version probe that starts a detached child and exits at once, so the child belongs to
 *   init before any tree or snapshot sees it, and only its inherited marker names it;
 * - processes an earlier, crashed run of the home left, found by its marker and its journal.
 * Processes carrying another run's marker are never touched.
 */
const fakeCodex = new URL("../../../packages/adapter-codex/src/testing/cli.ts", import.meta.url);
const cli = new URL("./cli.ts", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recorded(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(Number);
}

async function until(check: () => boolean, what: string, milliseconds = 20_000) {
  for (let waited = 0; waited < milliseconds; waited += 100) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** This test's own child, so its exit event (not kill(0), which a zombie answers) says it ended. */
function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** A long-lived process of this test's; `owner` puts a run's marker in its environment. */
function stray(owner?: string, command = process.execPath): ChildProcess {
  const child = spawn(command, strayArgs(command), {
    stdio: "ignore",
    detached: true,
    env: strayEnv(owner),
  });
  cleanups.push(() => {
    if (running(child)) child.kill("SIGKILL");
  });
  return child;
}

function strayArgs(command: string): string[] {
  return command === process.execPath ? ["-e", "setInterval(() => {}, 1000)"] : ["300"];
}

function strayEnv(owner: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (owner) env[PROCESS_OWNER_ENV] = owner;
  else delete env[PROCESS_OWNER_ENV];
  return env;
}

/**
 * What a crashed run leaves: a process whose parent is gone, so it belongs to init. Started
 * through a short-lived intermediary, so it is no descendant of this test (which may itself run
 * under an ace daemon's agent shell). Returns its pid.
 */
async function orphan(owner?: string, command = process.execPath): Promise<number> {
  const launcher = spawn(
    process.execPath,
    [
      "-e",
      `const c = require("node:child_process").spawn(${JSON.stringify(command)}, ${JSON.stringify(strayArgs(command))}, { stdio: "ignore", detached: true }); c.unref(); process.stdout.write(String(c.pid));`,
    ],
    { stdio: ["ignore", "pipe", "ignore"], env: strayEnv(owner) },
  );
  let out = "";
  launcher.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  await once(launcher, "exit");
  const pid = Number(out);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The orphan did not start");
  // Only this pid, which this test started.
  cleanups.push(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  return pid;
}

/** A fresh home and person, and a fake `codex` that records what it starts. */
async function home() {
  const root = await mkdtemp(join(tmpdir(), "ace-daemon-stop-"));
  const paths = {
    root,
    home: join(root, "ace"),
    person: join(root, "home"),
    bin: join(root, "bin"),
    turnPids: join(root, "turn-pids"),
    probePids: join(root, "probe-pids"),
    stopPids: join(root, "stop-pids"),
    stopOutput: join(root, "stop-output"),
  };
  await Promise.all([
    mkdir(paths.home),
    mkdir(join(paths.person, "project"), { recursive: true }),
    mkdir(paths.bin),
  ]);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  cleanups.push(() => {
    // Only processes this test's fake provider recorded.
    for (const pid of [
      ...recorded(paths.turnPids),
      ...recorded(paths.probePids),
      ...recorded(paths.stopPids),
    ])
      if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  await writeFile(
    join(paths.bin, "codex"),
    [
      `#!${process.execPath}`,
      'import { spawn } from "node:child_process";',
      'import { appendFileSync, openSync } from "node:fs";',
      // A probe that leaves a helper behind and exits before anything can see its tree.
      'if (process.argv.includes("--version")) {',
      '  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });',
      "  helper.unref();",
      `  appendFileSync(${JSON.stringify(paths.probePids)}, helper.pid + "\\n");`,
      "}",
      // A turn's work: what an agent's shells start once its turn begins.
      "let started = false;",
      "const write = process.stdout.write.bind(process.stdout);",
      "process.stdout.write = (chunk, ...rest) => {",
      "  if (!started && String(chunk).includes('\"turn/started\"')) {",
      "    started = true;",
      '    const inGroup = spawn("sleep", ["300"], { stdio: "ignore" });',
      '    const away = spawn("sleep", ["301"], { stdio: ["ignore", "inherit", "inherit"], detached: true });',
      "    away.unref();",
      `    appendFileSync(${JSON.stringify(paths.turnPids)}, [process.pid, inGroup.pid, away.pid].join("\\n") + "\\n");`,
      // An agent that runs `ace stop` from its own turn's shell, in the app-server's group.
      "    if (process.env.ACE_TEST_STOP_FROM_TURN) {",
      `      const out = openSync(${JSON.stringify(paths.stopOutput)}, "w");`,
      `      const stop = spawn(process.execPath, [${JSON.stringify(cli)}, "stop", "--json", "--timeout", "30s"], { stdio: ["ignore", out, out], env: process.env });`,
      `      appendFileSync(${JSON.stringify(paths.stopPids)}, stop.pid + "\\n");`,
      "    }",
      "  }",
      "  return write(chunk, ...rest);",
      "};",
      `await import(${JSON.stringify(fakeCodex.href)});`,
      "",
    ].join("\n"),
  );
  await chmod(join(paths.bin, "codex"), 0o755);
  const env = {
    ACE_HOME: paths.home,
    HOME: paths.person,
    PATH: `${paths.bin}:/usr/bin:/bin`,
    ACE_LOG_LEVEL: "silent",
    ACE_LISTEN: "local",
    ACE_MAINTENANCE: "0",
    ACE_DEV: "0",
    ACE_ACCOUNTS_DB: join(paths.home, "accounts.sqlite"),
    ACE_HISTORY_INSTANCES: "[]",
    ACE_MODEL_INSTANCES: "[]",
    ACE_APNS_KEY_FILE: "",
    ACE_VAPID_KEY_FILE: "",
    ACE_RELAY_URL: undefined,
    ACE_SCREEN_HELPER: undefined,
    // This test's own run must not mark the daemon it starts.
    [PROCESS_OWNER_ENV]: undefined,
  };
  return { ...paths, env };
}

/** `ace start` for `paths`'s home; resolves once it listens. */
async function startDaemon(paths: Awaited<ReturnType<typeof home>>, env: NodeJS.ProcessEnv = {}) {
  const daemon = spawn(process.execPath, [cli, "start"], {
    env: { ...process.env, ...paths.env, ...env, ACE_PORT: "0" },
    stdio: "ignore",
  });
  const exit = once(daemon, "exit");
  cleanups.push(() => {
    if (running(daemon)) daemon.kill("SIGKILL");
  });
  await until(
    () => existsSync(join(paths.home, "daemon-endpoint")),
    "the daemon to listen",
    30_000,
  );
  return { daemon, exit };
}

/** `ace stop`, then proof the daemon's process ended. */
async function stopDaemon(
  paths: Awaited<ReturnType<typeof home>>,
  daemon: { exit: Promise<unknown> },
) {
  const stopped = await invoke(paths.home, ["stop", "--json", "--timeout", "20s"], "", paths.env);
  expect(stopped.code, stopped.stderr).toBe(0);
  const answer: unknown = JSON.parse(stopped.stdout);
  expect(answer).toMatchObject({ stopped: true });
  // The daemon's own shutdown ended what it started, as it must when a service manager or the
  // app stops it with no `ace stop` to clean up after it.
  expect(answer).not.toHaveProperty("leftoversStopped");
  const exited = await Promise.race([
    daemon.exit.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  expect(exited).toBe(true);
}

test.skipIf(process.platform === "win32")(
  "ace stop leaves nothing of the daemon or its provider's process tree running",
  async () => {
    const paths = await home();
    const daemon = await startDaemon(paths);
    const started = await invoke(
      paths.home,
      ["run", "Say hello", "--project", join(paths.person, "project"), "--provider", "codex"],
      "",
      paths.env,
    );
    expect(started.code, started.stderr + started.stdout).toBe(0);
    // A thread's app-server, its grouped child and the one that left its group are running.
    await until(() => recorded(paths.turnPids).length >= 3, "the provider's processes");
    expect(recorded(paths.turnPids).every(alive)).toBe(true);
    await stopDaemon(paths, daemon);
    expect(recorded(paths.turnPids).filter(alive)).toEqual([]);
  },
  90_000,
);

test.skipIf(process.platform === "win32")(
  "ace stop ends a probe's detached child whose parent exited at once, and nothing another run marked",
  async () => {
    const paths = await home();
    // Another home's daemon run left this: same user, a marker that isn't this run's.
    const otherHome = stray("5d1f0a7e-2b3c-4d5e-8f90-a1b2c3d4e5f6");
    const unmarked = stray();
    const daemon = await startDaemon(paths);
    // Provider discovery probes `codex --version`; each probe left a helper behind and exited.
    await until(() => recorded(paths.probePids).length > 0, "a probe's helper");
    const helpers = recorded(paths.probePids);
    expect(helpers.every(alive)).toBe(true);
    await stopDaemon(paths, daemon);
    expect(recorded(paths.probePids).filter(alive)).toEqual([]);
    expect(running(otherHome)).toBe(true);
    expect(running(unmarked)).toBe(true);
  },
  90_000,
);

test.skipIf(process.platform === "win32")(
  "a daemon's start stops what an earlier crashed run of its home left, by marker and journal",
  async () => {
    const paths = await home();
    prepareDaemonHome(paths.home);
    const earlierRun = "0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10";
    // The earlier run left a marked helper, and a platform binary whose environment macOS
    // hides, known only from its journal row.
    const marked = await orphan(earlierRun);
    const journaled = await orphan(undefined, "/bin/sleep");
    // Not the earlier run's: another home's marked process, and a sleep with no journal row.
    const otherHome = await orphan("5d1f0a7e-2b3c-4d5e-8f90-a1b2c3d4e5f6");
    const stranger = await orphan(undefined, "/bin/sleep");
    const identity = processIdentity(journaled);
    if (!identity) throw new Error("The journaled orphan is not running");
    const journal = new EscapeeJournal(join(paths.home, "processes.sqlite"), earlierRun);
    journal.record([{ pid: identity.pid, start: identity.start }]);
    journal.close();
    // It crashed: its marker still says running, under a pid that has ended.
    await writeFile(
      join(paths.home, "daemon-run.json"),
      JSON.stringify({ state: "running", pid: 999_999, startedAt: 1, owner: earlierRun }),
    );
    const daemon = await startDaemon(paths);
    await until(() => !alive(marked) && !alive(journaled), "the earlier run's leftovers");
    expect(alive(otherHome)).toBe(true);
    expect(alive(stranger)).toBe(true);
    await stopDaemon(paths, daemon);
  },
  90_000,
);

test.skipIf(process.platform === "win32")(
  "ace stop run from a provider's own shell lives to report the daemon stopped",
  async () => {
    const paths = await home();
    const daemon = await startDaemon(paths, { ACE_TEST_STOP_FROM_TURN: "1" });
    const started = await invoke(
      paths.home,
      ["run", "Stop the daemon", "--project", join(paths.person, "project"), "--provider", "codex"],
      "",
      paths.env,
    );
    expect(started.code, started.stderr + started.stdout).toBe(0);
    // The turn's shell ran `ace stop`; the daemon's shutdown ends that turn's process group.
    await until(() => recorded(paths.stopPids).length > 0, "the turn's ace stop");
    const [caller = 0] = recorded(paths.stopPids);
    await until(() => !alive(caller), "the turn's ace stop to finish", 40_000);
    const output = existsSync(paths.stopOutput) ? readFileSync(paths.stopOutput, "utf8") : "";
    expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}"), output).toMatchObject({
      stopped: true,
    });
    const exited = await Promise.race([
      daemon.exit.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    expect(exited).toBe(true);
    // Everything else of the turn ended: the app-server and both of its children.
    expect(recorded(paths.turnPids).filter(alive)).toEqual([]);
  },
  90_000,
);
