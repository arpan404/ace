import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { chromium } from "playwright-core";

/** Replace process boundaries without replacing browser decision logic. */
export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;
export type ContextLauncher = typeof chromium.launchPersistentContext;
export const launchContext: ContextLauncher = async (profile, options) => {
  const { chromium } = await import("playwright-core");
  return chromium.launchPersistentContext(profile, options);
};
export const spawnProcess: ProcessSpawner = spawn;
