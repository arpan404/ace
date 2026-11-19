import { lockedUseEnvironment } from "../../packaging/locked-use.ts";
import { spawn } from "node:child_process";
import { closeSync, existsSync } from "node:fs";
import { DEFAULT_LOG_MAX_BYTES } from "@ace/diagnostics/log-policy";
import { openLaunchLog } from "@ace/service/launch-log";
import { dirname } from "node:path";
import { DaemonHealth } from "@ace/protocol";
import {
  encodeLoginPathLine,
  loginPathPending,
  prefixedPath,
  type PendingLoginPath,
} from "@ace/service/login-path";
import type { Launch } from "./launch-priority.ts";
import { requestStop } from "./stop-request.ts";
import { withoutBenchWorkerPreload } from "@ace/provider-kit/worker";
import type { DaemonProcess } from "./supervisor.ts";

/** Files the packaged app ships next to the daemon. */
export interface DaemonResources {
  /** `daemon/ace.mjs`: the esbuild daemon bundle from `@ace/release`. */
  entry: string;
  /** The platform screen helper (macOS: `Contents/Helpers/AceScreenHelper.app`). */
  screenHelper?: string | undefined;
  lockedUseDirectory?: string | undefined;
  screenHelperManifest?: string | undefined;
  /** Directory with the bundled `rg`, prepended to the daemon's PATH. */
  binDirectory?: string | undefined;
  /**
   * The bundled Node runtime (`runtime/bin/node`). Packaged apps run the daemon on it, so
   * Electron's `runAsNode` fuse stays off. Unpackaged development may fall back to
   * Electron as Node, whose fuses are not flipped.
   */
  node?: string | undefined;
  /** A packaged app must never fall back to Electron as Node: its fuse is off. */
  packaged?: boolean;
}

/** The program that runs the daemon bundle, and what its environment needs for that. */
export function daemonProgram(
  resources: DaemonResources,
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): { command: string; env: NodeJS.ProcessEnv } {
  if (resources.node && exists(resources.node)) return { command: resources.node, env: {} };
  if (resources.packaged)
    throw new Error(
      `The bundled Node runtime is missing (${resources.node ?? "runtime/bin/node"})`,
    );
  return { command: execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

export interface SpawnOptions {
  home: string;
  resources: DaemonResources;
  /** The login-shell PATH, so provider CLIs and git resolve as in a terminal. */
  path: string;
  /**
   * Set when `path` is last session's saved PATH: the login shell's, which the daemon gets on
   * its stdin and waits for before it reads provider CLIs (`spawn-path.ts`).
   */
  loginPath?: Promise<string> | undefined;
  version: string;
  env: NodeJS.ProcessEnv;
  /**
   * What this app has to say about the process itself (it could not be spawned, a stop request
   * failed). The daemon's own output goes to its home's launch log, never through this app.
   */
  report(line: string): void;
  /** The launch to spawn for the plain one (`daemonLaunchPolicy`); unset spawns it as is. */
  prioritize?: ((launch: Launch) => Launch) | undefined;
  /** The OS the daemon runs on; `process.platform` unless a test says otherwise. */
  platform?: NodeJS.Platform | undefined;
}

/**
 * The version the daemon reports in its health. An app version the health schema rejects (a
 * build-metadata suffix such as `1.0.0+local`) runs its daemon as `development` instead.
 */
function daemonVersion(appVersion: string): string {
  return DaemonHealth.shape.version.safeParse(appVersion).success ? appVersion : "development";
}

/** The daemon's PATH: the bundled tools' folder first, then `path`. */
export function daemonPath(resources: DaemonResources, path: string): string {
  return prefixedPath(resources.binDirectory, path);
}

/** Environment for the daemon child, run by `program`. */
export function daemonEnvironment(
  options: Omit<SpawnOptions, "report">,
  program: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const { resources } = options;
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    ...program,
    ACE_HOME: options.home,
    ACE_VERSION: daemonVersion(options.version),
    PATH: daemonPath(resources, options.path),
  };
  // The daemon reads the login shell itself, as below, if this app never sends its PATH.
  if (options.loginPath)
    env[loginPathPending] = JSON.stringify({
      prefix: resources.binDirectory,
      inherited: options.env.PATH ?? "",
    } satisfies PendingLoginPath);
  else delete env[loginPathPending];
  // Electron-only switches must not leak into the Node child.
  if (!program.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.NODE_OPTIONS;
  withoutBenchWorkerPreload(env);
  if (resources.screenHelper && existsSync(resources.screenHelper)) {
    env.ACE_SCREEN_HELPER = resources.screenHelper;
    if (resources.screenHelperManifest)
      env.ACE_SCREEN_HELPER_MANIFEST = resources.screenHelperManifest;
  }
  if (resources.packaged) {
    for (const key of [
      "ACE_LOCKED_USE_PLUGIN",
      "ACE_LOCKED_USE_BROKER",
      "ACE_LOCKED_USE_GUARDIAN",
      "ACE_LOCKED_USE_TEAM",
    ])
      delete env[key];
  }
  Object.assign(env, lockedUseEnvironment(resources.lockedUseDirectory));
  return env;
}

/**
 * Starts the bundled daemon so that it outlives this app (ADR 0186): detached, in its own process
 * group and session (on Windows, outside the job that would end it with the app), with its
 * stdout and stderr in its home's launch log (`@ace/service/launch-log`), so no pipe to this app
 * is left to break under it when the app quits. Its records go to its own `logs/ace.jsonl`.
 */
export function spawnDaemon(options: SpawnOptions): DaemonProcess {
  const program = daemonProgram(options.resources, process.execPath);
  const plain = { command: program.command, args: [options.resources.entry, "start"] };
  const launch = options.prioritize ? options.prioritize(plain) : plain;
  const output = openLaunchLog(options.home, DEFAULT_LOG_MAX_BYTES);
  let child: ReturnType<typeof spawnDetached>;
  try {
    child = spawnDetached(launch, options, program.env, output);
  } finally {
    // The daemon has its own copy now.
    closeSync(output);
  }
  // Nothing of this app keeps it alive, or waits on it at exit.
  child.unref();
  // A daemon that exited first closed its end; nothing is left to tell it.
  child.stdin.on("error", () => {});
  // Ending without a line lets the daemon go on with the PATH it started on. When this app quits
  // first, stdin ends the same way and the daemon asks the login shell itself.
  if (!options.loginPath) child.stdin.end();
  else
    void options.loginPath.then(
      (path) => child.stdin.end(encodeLoginPathLine(daemonPath(options.resources, path))),
      () => child.stdin.end(),
    );
  // A process that never started emits `error` and `close`, but no `exit`.
  type Exit = [code: number | null, signal: NodeJS.Signals | null, error?: string];
  let result: Exit | undefined;
  const listeners = new Set<(...exit: Exit) => void>();
  const finish = (...exit: Exit) => {
    if (result) return;
    result = exit;
    for (const listener of listeners) listener(...exit);
    listeners.clear();
  };
  child.once("exit", (code, signal) => finish(code, signal));
  child.on("error", (error) => {
    options.report(`spawn failed: ${error.message}`);
    if (child.pid === undefined) finish(null, null, error.message);
  });
  // Windows: SIGTERM would be TerminateProcess, so a graceful stop asks the daemon to shut down
  // and ends the process only if it refuses; SIGKILL ends it, and its job takes the children.
  if ((options.platform ?? process.platform) === "win32")
    return {
      pid: child.pid,
      kill: (signal) => {
        const running = () => child.exitCode === null && child.signalCode === null;
        if (!running()) return;
        if (signal !== "SIGTERM" || child.pid === undefined) {
          child.kill(signal);
          return;
        }
        void requestStop(options.home, child.pid)
          .then((accepted) => {
            if (!accepted && running()) child.kill(signal);
          })
          .catch((error: unknown) => options.report(`stop request failed: ${String(error)}`));
      },
      onExit: (listener) => {
        if (result) listener(...result);
        else listeners.add(listener);
      },
    };
  return {
    pid: child.pid,
    kill: (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
    onExit: (listener) => {
      if (result) listener(...result);
      else listeners.add(listener);
    },
  };
}

function spawnDetached(
  launch: Launch,
  options: SpawnOptions,
  program: NodeJS.ProcessEnv,
  output: number,
) {
  const child = spawn(launch.command, launch.args, {
    cwd: dirname(options.resources.entry),
    env: daemonEnvironment(options, program),
    stdio: ["pipe", output, output],
    detached: true,
    windowsHide: true,
  });
  // Node always opens a piped stdin; its typings for a mixed stdio list only lose track of it.
  const { stdin } = child;
  if (!stdin) throw new Error("The daemon's stdin did not open");
  return Object.assign(child, { stdin });
}

/** Runs a one-shot daemon CLI command (`doctor --json`) with the same environment. */
export function runDaemonCommand(
  options: Omit<SpawnOptions, "report">,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const program = daemonProgram(options.resources, process.execPath);
    const child = spawn(program.command, [options.resources.entry, ...args], {
      cwd: dirname(options.resources.entry),
      env: daemonEnvironment(options, program.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 100_000) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
