import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { durableJson, withInstallLock } from "./files.ts";
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
    return await withInstallLock(join(home, ".spade-update"), async () => {
      const result = await swapSpade(
        version,
        mode,
        localSpadeSwapPorts({ ...options.io, home, plan, source, version }),
      );
      if (result.kind === "swapped")
        await pruneSpadeReleases(home, [result.to, ...(result.from ? [result.from] : [])]);
      return result;
    });
  } catch (error) {
    return {
      kind: "failed",
      from: undefined,
      to: version,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reopens Spade's admission after an updater that closed it died (`ace update recover`).
 * Best effort: a Spade that isn't running has nothing to reopen.
 */
export async function reopenSpadeAdmission(home: string): Promise<void> {
  const ports = localSpadeSwapPorts({
    home,
    plan: await localSpadePlan(home),
    source: "",
    version: "0.0.0",
  });
  await ports.reopenAdmission().catch(() => {});
}

/**
 * The desktop app restarts into its update before Spade's turn comes, so the mode the person
 * chose (`now` for a confirmed Restart, `idle` for `ace update apply`) waits in this file for
 * the next launch.
 */
export const spadeUpdateModeFile = "spade-update-mode.json";
const PendingMode = z.object({ mode: z.enum(["idle", "now"]) });

export async function rememberSpadeUpdateMode(home: string, mode: SpadeSwapMode): Promise<void> {
  await durableJson(join(home, spadeUpdateModeFile), { mode });
}

/** The remembered mode, removed as it is read; `idle` when none was left. */
export async function takeSpadeUpdateMode(home: string): Promise<SpadeSwapMode> {
  const file = join(home, spadeUpdateModeFile);
  const text = await readFile(file, "utf8").catch(() => undefined);
  await rm(file, { force: true });
  if (text === undefined) return "idle";
  try {
    return PendingMode.parse(JSON.parse(text)).mode;
  } catch {
    return "idle";
  }
}
