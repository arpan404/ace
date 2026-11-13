import { readFile } from "node:fs/promises";
import { z } from "zod";
import { basename, dirname, join } from "node:path";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { runProcess, type Runner } from "./process.ts";
import type { SpadeServicePlan } from "./spade-plan.ts";

/** Whether Spade's service is registered and whether its program runs (ADR 0123). */
export type SpadeServiceState = "absent" | "stopped" | "running";

/** The service manager and a clock, injected so tests can stand in for both. */
export interface SpadeServicePorts {
  /** Visibility check; custom runtimes without one manage visibility themselves. */
  shown?(home: string): Promise<boolean>;
  run: Runner;
  wait(ms: number): Promise<void>;
}
const spadeVisibility = z.object({ spade: z.boolean() });

export const systemSpadePorts: SpadeServicePorts = {
  async shown(home) {
    try {
      const value: unknown = JSON.parse(await readFile(join(home, "features.json"), "utf8"));
      const parsed = spadeVisibility.safeParse(value);
      return parsed.success && parsed.data.spade;
    } catch {
      return false;
    }
  },
  run: runProcess,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function incompatibleSpadeService(file: string, cause?: unknown): Error {
  return new Error(
    `Incompatible Spade service at ${file}. Refusing to adopt, start or modify it; remove it yourself or choose a separate ACE_HOME.`,
    { cause },
  );
}

/** A bounded, no-follow read of a file ace wrote; undefined when it isn't there. */
export function readOwnFile(file: string): string | undefined {
  let directory: PinnedDirectory | undefined;
  try {
    directory = PinnedDirectory.atBoundary(dirname(file));
    return directory.readText(basename(file), 64 * 1024);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw incompatibleSpadeService(file, error);
  } finally {
    directory?.closeSync();
  }
}

/**
 * The registration (and on Windows the launcher) must be exactly what this build renders for
 * the home: an edited plist, unit, task record or launcher is never adopted or run.
 */
export function assertSpadeRegistration(plan: SpadeServicePlan): string | undefined {
  const content = readOwnFile(plan.file);
  if (content !== undefined && content !== plan.content)
    throw incompatibleSpadeService(plan.file, new Error("Unrecognized registration"));
  if (plan.platform === "win32") {
    const launcher = readOwnFile(plan.launcher.file);
    if (launcher !== undefined && launcher !== plan.launcher.content)
      throw incompatibleSpadeService(plan.launcher.file, new Error("Unrecognized launcher"));
  }
  return content;
}
