#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { findRunningDaemon } from "../src/main/daemon/probe.ts";
import { appEnvironment, desktop, e2eSwitches, electronBinary, repo } from "./common.ts";
import { measuredMain, measuredRenderer } from "./measure/build.ts";
import type { ScenarioConfig } from "./measure/scenario.ts";

/**
 * `node apps/desktop/scripts/measure-startup.ts`: how long opening the desktop app takes until
 * the shell, real thread rows and an enabled composer are on screen, uncovered (`open.ts`).
 * Release main/preload bundles, the production renderer from `app://ace/`, attached to a real
 * daemon from this checkout on the development home (`~/.ace/dev`, real threads and projects)
 * and its Electron profile (`~/.ace/dev-electron`), so the numbers are a real person's. It only
 * starts the daemon and app against them; it never seeds, resets or deletes them, and refuses
 * to run while another daemon holds the home. No provider CLI runs.
 *
 * - `reopen`: the daemon already runs and the Electron profile is the last run's (the usual
 *   case: the app quit and opened again).
 * - `first`: the daemon runs, the Electron profile is new (a temporary one): nothing cached.
 * - `cold`: the daemon starts together with the app, as after a reboot.
 * - `wake`: once live, the daemon is frozen (SIGSTOP) for `--asleep-ms` (20000) and runs again,
 *   as around a sleep (`--asleep-how stop`: it stops and starts again instead), and the app gets
 *   Electron's `resume` (`measure/wake.ts`): how long until it is live.
 *
 * Options: --runs <n> (5) --modes reopen,first,cold --home <dir> --user-data <dir> --port <n>
 * (4343) --daemon-entry <cli.ts or a release ace.mjs> --daemon-delay <ms> (0) --daemon-slow
 * --occlusion --hide-ms <ms> --skip-renderer --linger <ms> (3000: open after the marks, so the
 * window keeps what it showed for the next run)
 * --json <file>.
 */
const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    modes: { type: "string", default: "reopen,first,cold" },
    home: { type: "string", default: join(homedir(), ".ace", "dev") },
    "user-data": { type: "string", default: join(homedir(), ".ace", "dev-electron") },
    port: { type: "string", default: "4343" },
    // The daemon to run: its source (default) or a release bundle (`apps/daemon/bench/compile.ts --cli`).
    "daemon-entry": { type: "string", default: "apps/daemon/src/cli.ts" },
    "daemon-delay": { type: "string", default: "0" },
    "daemon-slow": { type: "boolean", default: false },
    occlusion: { type: "boolean", default: false },
    "hide-ms": { type: "string" },
    "skip-renderer": { type: "boolean", default: false },
    linger: { type: "string", default: "3000" },
    "asleep-ms": { type: "string", default: "20000" },
    "asleep-how": { type: "string", default: "freeze" },
    json: { type: "string" },
  },
});
const log = (message: string) => console.log(`[startup] ${message}`);
const out = join(desktop, "dist/measure-startup");

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

const scratch = await mkdtemp(join(tmpdir(), "ace-startup-"));
const home = args.home;
const port = Number(args.port);
if (home === join(homedir(), ".ace"))
  throw new Error("Never ~/.ace itself; use a development home");
if (await findRunningDaemon(home).catch(() => undefined))
  throw new Error(`Another daemon already holds ${home}; stop it first (this never does)`);
if (!(await portFree(port))) throw new Error(`Port ${port} is taken`);

function startDaemon(): { child: ChildProcess; startedAt: number } {
  const startedAt = performance.timeOrigin + performance.now();
  // `--daemon-slow`: the daemon on background QoS (efficiency cores, throttled I/O), so its whole
  // start runs slowly, as on a busy Mac, not only its spawn.
  const [command, ...rest] = [
    ...(args["daemon-slow"] ? ["taskpolicy", "-b"] : []),
    "bun",
    args["daemon-entry"],
    "start",
  ];
  const child = spawn(command ?? "bun", rest, {
    cwd: repo,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ACE_HOME: home, ACE_PORT: String(port), ACE_LISTEN: "local" },
  });
  child.stderr?.resume();
  return { child, startedAt };
}

async function untilRunning(timeoutMs = 60_000): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await findRunningDaemon(home).catch(() => undefined))
      return performance.timeOrigin + performance.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The daemon never came up");
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

type Marks = Record<string, number>;

async function launch(
  mainFile: string,
  userData: string,
  /** Wake mode: called once the app is live; the app waits for SIGUSR2 to wake. */
  live?: (app: ChildProcess) => Promise<void>,
): Promise<Marks> {
  const config: ScenarioConfig = {
    scenario: "open",
    hiddenMs: 0,
    streamMs: 0,
    settleMs: 0,
    churn: 0,
    pageUrl: "",
  };
  const started = performance.timeOrigin + performance.now();
  // A window another app or Space covers reads as hidden, and a hidden page is sent no thread
  // data (ADR 0056): on a shared Mac that measures the other app, not the start. `--occlusion`
  // keeps Chromium's occlusion tracking; hiding the window (`--hide-ms`) still hides it.
  const switches = args.occlusion ? [] : ["--disable-backgrounding-occluded-windows"];
  const child = spawn(
    await electronBinary(),
    [...e2eSwitches(process.platform), ...switches, mainFile],
    {
      stdio: ["ignore", "pipe", process.env.ACE_MEASURE_DEBUG ? "inherit" : "ignore"],
      env: {
        ...appEnvironment(process.env),
        ACE_DESKTOP_DAEMON: "attach",
        ACE_HOME: home,
        ACE_DESKTOP_USER_DATA: userData,
        ACE_DESKTOP_RENDERER_URL: "",
        ACE_MEASURE: JSON.stringify(config),
        // Never take the keyboard from whoever is using the Mac (`measure/entry.ts`).
        ACE_MEASURE_INACTIVE: "1",
        // Each run leaves what a person's session would: the next launch opens on it.
        ACE_MEASURE_LINGER_MS: args.linger,
        ...(live ? { ACE_MEASURE_WAKE: "1" } : {}),
        ...(args["hide-ms"] ? { ACE_MEASURE_HIDE_MS: args["hide-ms"] } : {}),
      },
    },
  );
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  let marks: Marks | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.startsWith("ACE_MEASURE ")) continue;
    const message = JSON.parse(line.slice("ACE_MEASURE ".length)) as {
      marks?: Marks;
      live?: boolean;
    };
    if (message.marks) marks = message.marks;
    if (message.live && live)
      void live(child).then(
        () => child.kill("SIGUSR2"),
        () => child.kill("SIGTERM"),
      );
  }
  await exited;
  if (!marks) throw new Error("The app reported no marks");
  return { ...marks, spawnedAt: started };
}

log("building main, preload and the production renderer");
const mainFile = await measuredMain(out);
if (!args["skip-renderer"]) measuredRenderer("production", out);

const shown = [
  "evaluated",
  "ready",
  "windowCreated",
  "windowShown",
  "rendererLoaded",
  "shell",
  "rows",
  "composer",
  "live",
  "shownAgain",
  "hidden",
  "daemonUpAt",
  "liveAfterUp",
  "wakeToLive",
] as const;
const results: Record<string, Marks[]> = {};
const record = (name: string, marks: Marks) => {
  (results[name] ??= []).push(marks);
  log(`${name}: ${shown.map((key) => `${key} ${marks[key]?.toFixed(0) ?? "-"}`).join(", ")}`);
};
const runs = Number(args.runs);
const modes = new Set(args.modes.split(","));

let daemon: ChildProcess | undefined;
try {
  if (modes.has("reopen") || modes.has("first")) {
    const started = startDaemon();
    daemon = started.child;
    log(
      `daemon up in ${((await untilRunning()) - started.startedAt).toFixed(0)} ms (${args["daemon-entry"]})`,
    );
    if (modes.has("reopen")) {
      // One launch first, so the profile holds this build's cache before the timed runs.
      await launch(mainFile, args["user-data"]);
      for (let index = 0; index < runs; index++)
        record("reopen", await launch(mainFile, args["user-data"]));
    }
    if (modes.has("first"))
      for (let index = 0; index < runs; index++)
        record("first", await launch(mainFile, join(scratch, `electron-first-${index}`)));
    await stopDaemon(daemon);
    daemon = undefined;
  }
  if (modes.has("cold")) {
    const userData = args["user-data"];
    for (let index = 0; index < runs; index++) {
      const app = launch(mainFile, userData);
      // A daemon slower to start than the app (a busy Mac): `--daemon-delay` ms after it.
      await new Promise((resolve) => setTimeout(resolve, Number(args["daemon-delay"])));
      const started = startDaemon();
      daemon = started.child;
      const [marks, upAt] = await Promise.all([app, untilRunning()]);
      // Times in the app's marks count from Electron's start; the daemon's from its own spawn.
      record("cold", {
        ...marks,
        daemonUp: upAt - started.startedAt,
        // When it answered, and how long after that the window was live, on the app's clock.
        ...(marks.origin === undefined
          ? {}
          : {
              daemonUpAt: upAt - marks.origin,
              ...(marks.live === undefined
                ? {}
                : { liveAfterUp: marks.live - (upAt - marks.origin) }),
            }),
      });
      log(`  daemon up ${(upAt - started.startedAt).toFixed(0)} ms after its spawn`);
      await stopDaemon(daemon);
      daemon = undefined;
    }
  }
  if (modes.has("wake")) {
    daemon = startDaemon().child;
    await untilRunning();
    for (let index = 0; index < runs; index++) {
      const marks = await launch(mainFile, args["user-data"], async () => {
        const asleepMs = Number(args["asleep-ms"]);
        if (args["asleep-how"] === "stop") {
          // The daemon goes away and comes back (a service restart around the sleep): the
          // page's refused retries back off meanwhile.
          if (daemon) await stopDaemon(daemon);
          daemon = undefined;
          await new Promise((resolve) => setTimeout(resolve, asleepMs));
          daemon = startDaemon().child;
        } else {
          // Frozen, as everything is while the Mac sleeps; then it runs again.
          const frozen = daemon;
          frozen?.kill("SIGSTOP");
          await new Promise((resolve) => setTimeout(resolve, asleepMs));
          frozen?.kill("SIGCONT");
        }
        await untilRunning();
      });
      log(
        `wake: live ${marks.wakeToLive?.toFixed(0) ?? "-"} ms after waking (off at wake: ${marks.offAtWake ?? "-"})`,
      );
      (results.wake ??= []).push(marks);
    }
  }
} finally {
  if (daemon) await stopDaemon(daemon);
}

const median = (list: Marks[], key: string) =>
  list.map((marks) => marks[key] ?? Number.NaN).toSorted((a, b) => a - b)[
    Math.floor(list.length / 2)
  ] ?? Number.NaN;
console.log("\nOpening the desktop app, median ms since the main process started\n");
console.log(["", ...shown, "daemonUp"].join("\t"));
for (const [name, list] of Object.entries(results))
  console.log(
    [
      `${name} (${list.length})`,
      ...[...shown, "daemonUp"].map((key) => median(list, key).toFixed(0)),
    ].join("\t"),
  );
// Stalled: never usable, or usable only when the startup screen's data cap (8 s) let it go,
// well after the window went live.
const stalled = (marks: Marks) =>
  marks.composer === undefined ||
  (marks.live !== undefined &&
    marks.composer - Math.max(marks.live, marks.shownAgain ?? 0) > 5_000);
for (const [name, list] of Object.entries(results))
  console.log(
    `${name}: ${list.filter(stalled).length} of ${list.length} stalled, ${list.filter((marks) => marks.hidden).length} saw the page hidden`,
  );
if (args.json) await writeFile(args.json, JSON.stringify(results, null, 2));
await rm(scratch, { recursive: true, force: true });
