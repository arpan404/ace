import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { DaemonHealth } from "@ace/protocol";
import type { Launch } from "./launch-priority.ts";
import { requestStop } from "./stop-request.ts";
import type { DaemonProcess } from "./supervisor.ts";

/** Files the packaged app ships next to the daemon. */
export interface DaemonResources {
  /** `daemon/ace.mjs`: the esbuild daemon bundle from `@ace/release`. */
  entry: string;
  /** The platform screen helper (macOS: `Contents/Helpers/AceScreenHelper.app`). */
  screenHelper?: string | undefined;
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
  version: string;
  env: NodeJS.ProcessEnv;
  /** One line of the daemon's output, without its newline. */
  onOutput(line: string, stream: "stdout" | "stderr"): void;
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

/** Environment for the daemon child, run by `program`. */
export function daemonEnvironment(
  options: Omit<SpawnOptions, "onOutput">,
  program: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const { resources } = options;
  const path = resources.binDirectory
    ? [resources.binDirectory, options.path].join(delimiter)
    : options.path;
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    ...program,
    ACE_HOME: options.home,
    ACE_VERSION: daemonVersion(options.version),
    PATH: path,
  };
  // Electron-only switches must not leak into the Node child.
  if (!program.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.NODE_OPTIONS;
  if (resources.screenHelper && existsSync(resources.screenHelper)) {
    env.ACE_SCREEN_HELPER = resources.screenHelper;
    if (resources.screenHelperManifest)
      env.ACE_SCREEN_HELPER_MANIFEST = resources.screenHelperManifest;
  }
  return env;
}

export function spawnDaemon(options: SpawnOptions): DaemonProcess {
  const program = daemonProgram(options.resources, process.execPath);
  const plain = { command: program.command, args: [options.resources.entry, "start"] };
  const launch = options.prioritize ? options.prioritize(plain) : plain;
  const child = spawn(launch.command, launch.args, {
    cwd: dirname(options.resources.entry),
    env: daemonEnvironment(options, program.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const [name, stream] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) options.onOutput(line, name);
      // A line that never ends must not grow without bound.
      if (pending.length > 65_536) {
        options.onOutput(pending, name);
        pending = "";
      }
    });
    // The last line before exit (a fatal error's) often has no newline.
    stream.on("end", () => {
      if (pending) options.onOutput(pending, name);
      pending = "";
    });
  }
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
    options.onOutput(`spawn failed: ${error.message}`, "stderr");
    if (child.pid === undefined) finish(null, null, error.message);
  });
  // Windows: SIGTERM would be TerminateProcess, so a graceful stop asks the daemon to shut down
  // and ends the process only if it refuses; SIGKILL ends it, and its job takes the children.
  if ((options.platform ?? process.platform) === "win32")
    return {
      kill: (signal) => {
        const running = () => child.exitCode === null && child.signalCode === null;
        if (!running()) return;
        if (signal !== "SIGTERM" || child.pid === undefined) {
          child.kill(signal);
          return;
        }
        void requestStop(options.home, child.pid).then((accepted) => {
          if (!accepted && running()) child.kill(signal);
        });
      },
      onExit: (listener) => {
        if (result) listener(...result);
        else listeners.add(listener);
      },
    };
  return {
    kill: (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
    onExit: (listener) => {
      if (result) listener(...result);
      else listeners.add(listener);
    },
  };
}

/** Runs a one-shot daemon CLI command (`doctor --json`) with the same environment. */
export function runDaemonCommand(
  options: Omit<SpawnOptions, "onOutput">,
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
