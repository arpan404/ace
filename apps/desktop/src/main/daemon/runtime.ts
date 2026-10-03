import { readFileSync } from "node:fs";
import type { DaemonConnection, DaemonStatus } from "../../shared/contract.ts";
import { DoctorReport, providerSummaries, type ProviderSummary } from "../../shared/onboarding.ts";
import { loginShellPath } from "./login-path.ts";
import {
  findRunningDaemon,
  healthy,
  maintenanceBlockers,
  readLocalDaemon,
  setMaintenance,
  type LocalDaemon,
} from "./probe.ts";
import { loginService } from "./service.ts";
import { runDaemonCommand, spawnDaemon, type DaemonResources } from "./spawn.ts";
import { DaemonSupervisor } from "./supervisor.ts";
import { resolveTarget, type DaemonTarget } from "./target.ts";

export interface RuntimeOptions {
  packaged: boolean;
  version: string;
  resources: DaemonResources;
  env: NodeJS.ProcessEnv;
  log(level: "info" | "warn" | "error", message: string): void;
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
  private status: DaemonStatus;
  private resolvedPath = "";
  private listeners = new Set<(status: DaemonStatus) => void>();

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.target = resolveTarget(options.env, {
      packaged: options.packaged,
      daemonEntry: options.resources.entry,
      readToken: (path) => readFileSync(path, "utf8"),
    });
    this.path = loginShellPath(options.env);
    const source =
      this.target.kind === "remote" ? "remote" : this.target.kind === "fake" ? "fake" : "external";
    this.status = { state: "starting", source, restarts: 0, paused: false };
    if (this.target.kind === "managed" || this.target.kind === "attach") {
      const home = this.target.home;
      this.supervisor = new DaemonSupervisor(
        {
          spawn:
            this.target.kind === "managed"
              ? () =>
                  spawnDaemon({
                    ...this.spawnOptions(home, this.resolvedPath),
                    onOutput: (line) => options.log("info", `daemon: ${line}`),
                  })
              : undefined,
          find: () => findRunningDaemon(home),
          healthy,
          service: this.target.kind === "managed" ? loginService(home) : undefined,
          setMaintenance,
          blockers: maintenanceBlockers,
          timers: {
            set(delayMs, callback) {
              const timer = setTimeout(callback, delayMs);
              return () => clearTimeout(timer);
            },
          },
          now: Date.now,
          log: options.log,
        },
        {},
      );
      this.supervisor.onStatus((status) => this.update(status));
    }
  }

  async start(): Promise<void> {
    this.resolvedPath = await this.path;
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
    if (this.target.kind === "remote")
      return { mode: "daemon", url: this.target.url, token: this.target.token };
    if (!this.supervisor) throw new Error("No local daemon for this target");
    const daemon = await this.supervisor.reachable();
    return { mode: "daemon", url: daemon.url, token: daemon.token };
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

  /** Stop only a daemon this app started. */
  async stop(): Promise<void> {
    await this.supervisor?.stop();
  }

  /** Whether the local daemon files exist at all (for the "not running" state in dev). */
  async present(): Promise<boolean> {
    if (this.target.kind !== "managed" && this.target.kind !== "attach") return true;
    return Boolean(await readLocalDaemon(this.target.home));
  }

  private spawnOptions(home: string, path: string) {
    return {
      home,
      resources: this.options.resources,
      path,
      version: this.options.version,
      env: this.options.env,
    };
  }

  private update(status: DaemonStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
