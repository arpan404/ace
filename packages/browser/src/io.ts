import { guardChromium } from "./process-guardian.ts";
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
  if (process.platform === "win32") return chromium.launchPersistentContext(profile, options);
  const guardian = await guardChromium(profile);
  try {
    const context = await chromium.launchPersistentContext(profile, options);
    const close = context.close.bind(context);
    context.once("close", () => {
      void guardian.close().catch(() => {});
    });
    context.close = async (closeOptions) => {
      try {
        await close(closeOptions);
      } finally {
        await guardian.close();
      }
    };
    return context;
  } catch (error) {
    // Playwright owns failed launches. Keep their cause if guardian teardown also fails.
    await guardian.close().catch(() => {});
    throw error;
  }
};
export const spawnProcess: ProcessSpawner = spawn;
