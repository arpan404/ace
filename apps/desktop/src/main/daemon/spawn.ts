import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname } from "node:path";
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
  onOutput(line: string): void;
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
    ACE_VERSION: options.version,
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
  const child = spawn(program.command, [options.resources.entry, "start"], {
    cwd: dirname(options.resources.entry),
    env: daemonEnvironment(options, program.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) options.onOutput(line);
    });
  }
  child.on("error", (error) => options.onOutput(`spawn failed: ${error.message}`));
  return {
    kill: (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
    onExit: (listener) => {
      child.once("exit", listener);
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
