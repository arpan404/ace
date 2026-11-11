import { existsSync } from "node:fs";
import { join } from "node:path";
import { withInstallLock } from "./files.ts";
import { localSpadePlan } from "./spade-local.ts";
import type { SpadeServicePlan } from "./spade-plan.ts";
import { pruneSpadeReleases } from "./spade-release.ts";
import { swapSpade, type SpadeSwapMode, type SpadeSwapResult } from "./spade-swap.ts";
import { localSpadeSwapPorts, type SpadeSwapIo } from "./spade-swap-ports.ts";

/**
 * Updates Spade to the release's `spade-server` at `source` (ADR 0123), after the daemon. Holds
 * its own lock, so two updaters never swap Spade at once, and keeps only the new and the
 * previous binary afterwards. Never throws: the result says what happened.
 */
export async function updateSpade(options: {
  home: string;
  source: string;
  version: string;
  mode: SpadeSwapMode;
  plan?: SpadeServicePlan;
  io?: Partial<SpadeSwapIo>;
}): Promise<SpadeSwapResult> {
  const { home, source, version, mode } = options;
  if (!existsSync(source)) return { kind: "skipped", reason: "not-shipped" };
  try {
    const plan = options.plan ?? (await localSpadePlan(home));
    const result = await withSpadeLock(home, async () => {
      const swapped = await swapSpade(
        version,
        mode,
        localSpadeSwapPorts({ ...options.io, home, plan, source, version }),
      );
      if (swapped.kind === "swapped")
        await pruneSpadeReleases(home, [swapped.to, ...(swapped.from ? [swapped.from] : [])]);
      return swapped;
    });
    if (result !== busy) return result;
    return {
      kind: "failed",
      from: undefined,
      to: version,
      error: "Another update is swapping Spade right now",
    };
  } catch (error) {
    return {
      kind: "failed",
      from: undefined,
      to: version,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const busy = Symbol("busy");
// SQLITE_BUSY and SQLITE_LOCKED: another updater holds Spade's lock.
const busyCodes = new Set([5, 6]);

/** Runs `work` holding Spade's update lock, or answers `busy` when another updater holds it. */
async function withSpadeLock<T>(home: string, work: () => Promise<T>): Promise<T | typeof busy> {
  try {
    return await withInstallLock(join(home, ".spade-update"), work);
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "errcode") : undefined;
    if (typeof code === "number" && busyCodes.has(code)) return busy;
    throw error;
  }
}

/**
 * Reopens Spade's admission after an updater that closed it died (`ace update recover`, and
 * the start of every `apply`). Only under Spade's update lock, so it never reopens Spade in the
 * middle of another updater's swap (that one holds the lock and is left alone), and only for a
 * Spade whose service runs. Best effort: never throws.
 */
export async function reopenSpadeAdmission(
  home: string,
  options: { plan?: SpadeServicePlan; io?: Partial<SpadeSwapIo> } = {},
): Promise<"reopened" | "busy" | "not-running" | "failed"> {
  try {
    const plan = options.plan ?? (await localSpadePlan(home));
    const ports = localSpadeSwapPorts({
      ...options.io,
      home,
      plan,
      source: "",
      version: "0.0.0",
    });
    const result = await withSpadeLock(home, async () => {
      if ((await ports.state()) !== "running") return "not-running" as const;
      await ports.reopenAdmission();
      return "reopened" as const;
    });
    return result === busy ? "busy" : result;
  } catch {
    return "failed";
  }
}
