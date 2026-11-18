import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { prepareDaemonHome, resolveDaemonHome } from "@ace/service/home";
import type { DaemonConnection, DaemonStatus } from "../../shared/contract.ts";
import { DoctorReport, providerSummaries, type ProviderSummary } from "../../shared/onboarding.ts";
import type { Log } from "../log/desktop-log.ts";
import { daemonLaunchPolicy, systemLaunchPort } from "./launch-priority.ts";
import { loginShellPath } from "@ace/service/login-path";
import { readSavedPath, writeSavedPath } from "./login-path.ts";
import { launchPaths, type LaunchPaths, type SpawnPath } from "./spawn-path.ts";
import { watchEndpointFile } from "./endpoint-watch.ts";
import {
  daemonHealth,
  findRunningDaemon,
  maintenanceBlockers,
  maintenanceStatus,
  readLocalDaemon,
  setMaintenance,
  setUpdateHold,
  type LocalDaemon,
} from "./probe.ts";
import { expectedLocalDaemon } from "./expected.ts";
import { loginService } from "./service.ts";
import { ownershipPorts } from "./ownership-ports.ts";
import { runDaemonCommand, spawnDaemon, type DaemonResources, type SpawnOptions } from "./spawn.ts";
import type { DaemonProcess } from "./supervisor.ts";
import { DaemonSupervisor } from "./supervisor.ts";
import { resolveTarget, type DaemonTarget } from "./target.ts";
import type { FreezeSignal } from "./watchdog.ts";

/**
 * The app's daemon target from its environment, with the daemon home chosen by
 * `@ace/service`'s shared resolver under the user's home directory and, for the managed
 * daemon, prepared (created, or given a fresh start) before the app writes anything there.
 */
export function desktopTarget(input: {
  env: NodeJS.ProcessEnv;
  packaged: boolean;
  daemonEntry: string;
  platform: NodeJS.Platform;
}): DaemonTarget {
  return resolveTarget(input.env, {
    packaged: input.packaged,
    daemonEntry: input.daemonEntry,
    readToken: (path) => readFileSync(path, "utf8"),
    platform: input.platform,
    homedir: homedir(),
    resolveHome: resolveDaemonHome,
    prepareHome(home) {
      const prepared = prepareDaemonHome(home);
      return prepared.state === "fresh"
        ? { backup: prepared.backup, previousFormat: prepared.previousFormat }
        : undefined;
    },
  });
}

export interface RuntimeOptions {
  packaged: boolean;
  version: string;
  resources: DaemonResources;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The daemon this app talks to, when the caller chose it already (see `desktopTarget`). */
  target?: DaemonTarget;
  /** Starts the bundled daemon; tests substitute their own. */
  spawnDaemon?: (options: SpawnOptions) => DaemonProcess;
  /** The supervisor's decisions and the runtime's own records. */
  log: Log;
  /**
   * Milliseconds since the app launched, for the launch steps the log records (login PATH,
   * first lookup, spawn, running). Without it those records are not written.
   */
  sinceLaunch?: () => number;
  /** The app's one main-thread beat (`diagnostics/main-beat.ts`), read on `Date.now`'s clock. */
  freezes?: FreezeSignal;
  /**
   * Where the login shell's PATH is saved between launches (in the app's data folder), so the
   * next launch can spawn the daemon without waiting for the shell. Without it, every spawn
   * waits for the shell.
   */
  savedPathFile?: string;
}

/**
 * Everything the app knows about its daemon: which one (managed, dev, remote or fake), how
 * to reach it, its status, and the doctor. Only the managed target spawns anything.
 */
export class DaemonRuntime {
  readonly target: DaemonTarget;
  readonly supervisor: DaemonSupervisor | undefined;
  private options: RuntimeOptions;
  private path: Promise<string>;
  private paths: LaunchPaths;
  private status: DaemonStatus;
  private spawnPath: SpawnPath = { path: "" };
  private listeners = new Set<(status: DaemonStatus) => void>();

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.target =
      options.target ??
      desktopTarget({
        env: options.env,
        packaged: options.packaged,
        daemonEntry: options.resources.entry,
        platform: options.platform ?? process.platform,
      });
    this.path = loginShellPath(options.env);
    const launchStep = (message: string, data: Record<string, unknown> = {}) => {
      if (options.sinceLaunch)
        options.log("info", message, { ...data, sinceLaunchMs: Math.round(options.sinceLaunch()) });
    };
    // loginShellPath answers the current PATH when the shell fails: this cannot reject.
    void this.path.then(() => launchStep("The login shell's PATH is ready")).catch(() => {});
    const savedPathFile = options.savedPathFile;
    this.paths = launchPaths({
      saved: savedPathFile ? readSavedPath(savedPathFile) : undefined,
      login: this.path,
      save: (path) => {
        if (!savedPathFile) return;
        void writeSavedPath(savedPathFile, path).catch((error: unknown) =>
          options.log("warn", `Could not save the login shell's PATH: ${String(error)}`),
        );
      },
    });
    let looked = false;
    const source =
      this.target.kind === "remote" ? "remote" : this.target.kind === "fake" ? "fake" : "external";
    this.status =
      this.target.kind === "remote-only"
        ? {
            state: "unavailable",
            source: "remote",
            restarts: 0,
            paused: false,
            message: this.target.reason,
          }
        : this.target.kind === "refused"
          ? {
              state: "failed",
              source: "external",
              restarts: 0,
              paused: false,
              message: this.target.reason,
            }
          : { state: "starting", source, restarts: 0, paused: false };
    if (this.target.kind === "managed" || this.target.kind === "attach") {
      const home = this.target.home;
      const launchPolicy = daemonLaunchPolicy(
        systemLaunchPort(options.platform ?? process.platform),
      );
      this.supervisor = new DaemonSupervisor(
        {
          spawn:
            this.target.kind === "managed"
              ? ({ safeMode }) => {
                  const { path, confirm } = this.spawnPath;
                  launchStep("Spawning the daemon", { safeMode, savedPath: Boolean(confirm) });
                  return (options.spawnDaemon ?? spawnDaemon)({
                    ...this.spawnOptions(home, path, safeMode),
                    loginPath: confirm,
                    prioritize: launchPolicy.wrap,
                    report: (line) => options.log("warn", `daemon: ${line}`),
                  });
                }
              : undefined,
          prepareSpawn: async () => {
            const [path] = await Promise.all([this.paths.next(), launchPolicy.ready()]);
            this.spawnPath = path;
          },
          watchEndpoint: () => watchEndpointFile(home),
          find: async () => {
            const found = await findRunningDaemon(home);
            if (!looked) launchStep("Looked for a running daemon", { found: Boolean(found) });
            looked = true;
            return found;
          },
          health: daemonHealth,
          // Only the managed daemon is ever the app's; development's is `bun run daemon`'s.
          ...(this.target.kind === "managed"
            ? ownershipPorts({
                home,
                version: options.version,
                platform: options.platform ?? process.platform,
                now: Date.now,
              })
            : {}),
          service: this.target.kind === "managed" ? loginService(home) : undefined,
          setMaintenance,
          setUpdateHold,
          blockers: maintenanceBlockers,
          maintenance: maintenanceStatus,
          timers: {
            set(delayMs, callback) {
              const timer = setTimeout(callback, delayMs);
              return () => clearTimeout(timer);
            },
          },
          now: Date.now,
          freezes: options.freezes,
          log: options.log,
        },
        {},
      );
      let ran = false;
      this.supervisor.onStatus((status) => {
        if (status.state === "running" && !ran) {
          ran = true;
          launchStep("The daemon is running", { source: status.source });
        }
        this.update(status);
      });
    }
  }

  /**
   * Adopting a daemon that already runs needs no PATH. A spawn uses the PATH saved last launch
   * and hands the login shell's (seconds on a busy shell profile) to the daemon once it answers;
   * only a first launch, with nothing saved, waits for the shell (`spawn-path.ts`).
   */
  async start(): Promise<void> {
    if (this.target.kind === "remote" || this.target.kind === "fake") {
      this.update({
        ...this.status,
        state: "running",
        ...(this.target.kind === "remote" ? { url: this.target.url } : {}),
      });
      return;
    }
    // Development (attach) waits for `bun run daemon` and never spawns one itself.
    await this.supervisor?.start();
  }

  /** The login shell's PATH, asked once per launch. */
  loginPath(): Promise<string> {
    return this.path;
  }

  current(): DaemonStatus {
    return this.status;
  }
  onStatus(listener: (status: DaemonStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The renderer's connection: resolves once the daemon answers, however slow its start.
   * Rejects only on a real failure, so the page shows its connection screen only then.
   */
  async connection(): Promise<DaemonConnection> {
    if (this.target.kind === "fake") return { mode: "fake" };
    if (this.target.kind === "remote-only" || this.target.kind === "refused")
      throw new Error(this.target.reason);
    if (this.target.kind === "remote")
      return {
        mode: "daemon",
        url: this.target.url,
        token: this.target.token,
        ...(this.target.pairedDeviceId ? { pairedDeviceId: this.target.pairedDeviceId } : {}),
      };
    if (!this.supervisor) throw new Error("No local daemon for this target");
    const daemon = await this.supervisor.reachable();
    return {
      mode: "daemon",
      url: daemon.url,
      token: daemon.token,
      ...(daemon.hostId ? { localHostId: daemon.hostId } : {}),
    };
  }

  /**
   * The connection the renderer will most likely get, without waiting for the daemon: a remote
   * target as configured, or the local daemon its home's files name, or at the address the page
   * was last handed (`remembered`; `expectedLocalDaemon`).
   * The page opens on what it kept for that daemon while it starts; `connection()` still says
   * which one it is. Null when there's no telling.
   */
  async expected(remembered?: string): Promise<DaemonConnection | null> {
    if (this.target.kind === "remote") return this.connection();
    if (this.target.kind !== "managed" && this.target.kind !== "attach") return null;
    const daemon = await expectedLocalDaemon(this.target.home, remembered);
    return daemon
      ? {
          mode: "daemon",
          url: daemon.url,
          token: daemon.token,
          ...(daemon.hostId ? { localHostId: daemon.hostId } : {}),
        }
      : null;
  }

  /** The local daemon's address, once running (managed or dev). */
  async local(): Promise<LocalDaemon> {
    if (!this.supervisor) throw new Error("No local daemon for this target");
    return this.supervisor.ready();
  }

  async restart(): Promise<DaemonStatus> {
    if (!this.supervisor || this.target.kind !== "managed") return this.status;
    return this.supervisor.restart();
  }

  async pause(on: boolean): Promise<DaemonStatus> {
    if (!this.supervisor) throw new Error("Pausing needs a local daemon");
    return this.supervisor.pause(on);
  }

  /** `ace doctor --json` with the bundled daemon (managed) for the repair flow. */
  async diagnose(): Promise<DoctorReport> {
    if (this.target.kind !== "managed")
      throw new Error(
        "Diagnostics run against the bundled daemon; use `bun run doctor` in development",
      );
    const result = await runDaemonCommand(this.spawnOptions(this.target.home, await this.path), [
      "doctor",
      "--json",
    ]);
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    try {
      return DoctorReport.parse(JSON.parse(line));
    } catch {
      throw new Error(result.stderr.trim() || "The doctor did not produce a report");
    }
  }

  async providers(): Promise<ProviderSummary[]> {
    return providerSummaries(await this.diagnose());
  }

  /**
   * Before the app restarts into an update: close admission on the daemon this app started
   * and wait up to `deadlineMs` for running work to finish. Any other daemon (the CLI's, the
   * login service's, a remote one) keeps running through the app's restart, so nothing waits.
   */
  async drainForUpdate(deadlineMs: number, waiting: (count: number) => void): Promise<boolean> {
    if (!this.supervisor || this.target.kind !== "managed") return true;
    return this.supervisor.drain(deadlineMs, 1_000, waiting);
  }

  /**
   * Threads still at work in the daemon this app started: the ones an update's restart stops.
   * Any other daemon keeps running through the restart, so it counts none.
   */
  async busyForUpdate(): Promise<number> {
    if (!this.supervisor || this.target.kind !== "managed") return 0;
    return this.supervisor.busy();
  }

  /**
   * Stop the daemon this app started (an earlier launch's included), never anyone else's: "Quit
   * ace completely", and before an update installs.
   */
  async stop(): Promise<void> {
    await this.supervisor?.stop();
  }

  /** A plain quit: the app goes and its daemon keeps running for the next launch (ADR 0186). */
  async release(): Promise<void> {
    await this.supervisor?.release();
  }

  /** Whether the local daemon files exist at all (for the "not running" state in dev). */
  async present(): Promise<boolean> {
    if (this.target.kind !== "managed" && this.target.kind !== "attach") return true;
    return Boolean(await readLocalDaemon(this.target.home));
  }

  private spawnOptions(home: string, path: string, safeMode = false) {
    const env = { ...this.options.env };
    // Only the supervisor decides a safe start, never an inherited environment.
    if (safeMode) env.ACE_SAFE_MODE = "1";
    else delete env.ACE_SAFE_MODE;
    return { home, resources: this.options.resources, path, version: this.options.version, env };
  }

  private update(status: DaemonStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
