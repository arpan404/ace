import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chromium } from "playwright-core";

/** Replace process boundaries without replacing browser decision logic. */
export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;
export type ContextLauncher = typeof chromium.launchPersistentContext;
export const launchContext: ContextLauncher = (profile, options) =>
  chromium.launchPersistentContext(profile, options);
export const spawnProcess: ProcessSpawner = spawn;
