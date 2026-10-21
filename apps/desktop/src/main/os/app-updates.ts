import { existsSync } from "node:fs";
import { join } from "node:path";
import type { UpdateStatus } from "../../shared/contract.ts";
import { repositoryUrl } from "../links.ts";
import {
  scheduleChecks,
  UpdateController,
  type CheckOrigin,
  type UpdateEngine,
} from "./update-controller.ts";

/** How long Restart waits for running agents before the update stays ready (ADR 0041). */
export const updateDrainMs = 5 * 60_000;

export interface AppUpdatesOptions {
  version: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  timers: { set(delayMs: number, callback: () => void): () => void };
  /** A number in [0, 1): offsets each background check so installs don't ask in step. */
  random(): number;
  report(status: UpdateStatus): void;
  drain(deadlineMs: number, waiting: (count: number) => void): Promise<boolean>;
  prepareQuit(): Promise<void>;
  quit(): void;
  log(level: "info" | "warn", message: string): void;
}

export interface AppUpdates {
  current(): UpdateStatus;
  check(origin: CheckOrigin): Promise<UpdateStatus>;
  apply(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  install(): Promise<UpdateStatus>;
  /** Background checks, for a build that has a feed. */
  start(): void;
}

const unconfigured: UpdateEngine = {
  canInstall: false,
  check: () => Promise.reject(new Error("Updates are not configured for this build")),
  download: () => Promise.reject(new Error("Updates are not configured for this build")),
  install() {},
};

/**
 * The app's update service: the controller over electron-updater, which loads only when
 * the first check runs (the updater and its YAML parser stay out of startup).
 */
export function appUpdates(options: AppUpdatesOptions): AppUpdates {
  let loading: Promise<UpdateEngine> | undefined;
  let loaded: UpdateEngine | undefined;
  const load = () =>
    (loading ??= import("./updates.ts")
      .then(({ electronUpdateEngine }) => electronUpdateEngine(options))
      .then((engine) => (loaded = engine ?? unconfigured)));
  const engine: UpdateEngine = {
    get canInstall() {
      return loaded?.canInstall ?? false;
    },
    check: async () => (await load()).check(),
    download: async (progress) => (await load()).download(progress),
    install: () => loaded?.install(),
  };
  // Only release packaging writes the feed; local and development builds never check.
  const enabled = options.packaged && existsSync(join(options.resourcesPath, "app-update.yml"));
  const controller = new UpdateController({
    engine,
    version: options.version,
    enabled,
    releaseUrl: (version) => `${repositoryUrl}/releases/tag/v${version}`,
    drain: (waiting) => options.drain(updateDrainMs, waiting),
    prepareQuit: options.prepareQuit,
    quit: options.quit,
    report: options.report,
    log: options.log,
  });
  return {
    current: () => controller.current(),
    check: (origin) => controller.check(origin),
    apply: () => controller.apply(),
    download: () => controller.download(),
    install: () => controller.install(),
    start() {
      if (enabled) scheduleChecks(controller, options.timers, options.random);
    },
  };
}
