import { z } from "zod";
import type { SpadeServiceState } from "./spade-registration.ts";

/**
 * Spade's side of an update (ADR 0123 decision 4, the contract's Updates steps 1-4). Pure
 * orchestration: every effect goes through `SpadeSwapPorts`, so the order and the failure
 * handling are tested with fakes and the I/O lives in `spade-swap-ports.ts`.
 *
 * 1. `POST /v1/maintenance` closes admission (`idle` or `now`).
 * 2. Wait: `idle` until no turn and no background job runs; `now` only for running model steps.
 * 3. Copy the new binary in, run `spade-server --check-migrations` on a SQLite backup, flip
 *    `current`, restart the service. Any failure keeps the old `current` and reopens admission.
 * 4. The new Spade resumes its paused turns by itself.
 */
export type SpadeSwapMode = "idle" | "now";

export const SpadeMaintenance = z.object({
  admission: z.enum(["open", "closed"]),
  running_turns: z.number().int().nonnegative(),
  running_jobs: z.number().int().nonnegative(),
});
export type SpadeMaintenance = z.infer<typeof SpadeMaintenance>;

export interface SpadeSwapPorts {
  state(): Promise<SpadeServiceState>;
  installedVersion(): Promise<string | undefined>;
  /** `POST /v1/maintenance` `{mode, deadline_ms}`. */
  closeAdmission(mode: SpadeSwapMode, deadlineMs: number): Promise<SpadeMaintenance>;
  /** `GET /v1/maintenance`. */
  maintenance(): Promise<SpadeMaintenance>;
  /** `DELETE /v1/maintenance`: an aborted update. */
  reopenAdmission(): Promise<void>;
  /** Copies the new binary to `releases/spade/<version>/`, leaving `current` alone. */
  stage(): Promise<void>;
  /**
   * A SQLite backup of `spade.sqlite`, kept until the new version is up so a rollback can put
   * it back; undefined when Spade has no database yet.
   */
  snapshot(): Promise<string | undefined>;
  /**
   * `spade-server --check-migrations` with the new binary on a copy of `snapshot` (the check
   * migrates the file it is given); throws why it can't.
   */
  checkMigrations(snapshot: string): Promise<void>;
  /** Puts `snapshot` back as `spade.sqlite`, its WAL files cleared. Spade must be stopped. */
  restoreDatabase(snapshot: string): Promise<void>;
  removeSnapshot(snapshot: string): Promise<void>;
  /** Points `releases/spade/current` at `version`. */
  flip(version: string): Promise<void>;
  /** The pid in Spade's `server.json`, if any: the process a restart must replace. */
  serverPid(): Promise<number | undefined>;
  stop(): Promise<void>;
  /** Restarts (or starts, when it was stopped) the service on the current binary. */
  restart(): Promise<void>;
  /**
   * Whether a Spade other than `oldPid` is up at `version`: `server.json` names a new pid and
   * `/health?nonce` answers that version with the proof only the token's holder can give
   * (waiting a little for the restart).
   */
  health(version: string, oldPid: number | undefined): Promise<boolean>;
  wait(ms: number): Promise<void>;
  now(): number;
}

export type SpadeSwapResult =
  /** `absent`: Spade's service isn't registered; `not-shipped`: a DISABLE_SPADE=1 release. */
  | { kind: "skipped"; reason: "absent" | "current" | "not-shipped" }
  | { kind: "swapped"; from: string | undefined; to: string }
  | { kind: "failed"; from: string | undefined; to: string; error: string };

type Failed = Extract<SpadeSwapResult, { kind: "failed" }>;

/** How long each mode lets Spade's work finish: `now` only its model steps (30 s). */
export const spadeDeadlines: Record<SpadeSwapMode, number> = { idle: 300_000, now: 30_000 };
/**
 * The updater waits this much past the deadline it gives Spade, so it sees Spade's own outcome
 * (turns paused once the allowance ends) instead of racing it.
 */
export const spadeDeadlineMarginMs = 10_000;
const pollMs = 500;

/** Whether Spade's work has stopped enough to swap in `mode`. */
export function spadeQuiet(mode: SpadeSwapMode, status: SpadeMaintenance): boolean {
  if (status.admission !== "closed") return false;
  if (mode === "now") return status.running_turns === 0;
  return status.running_turns === 0 && status.running_jobs === 0;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Swaps Spade to `version`, or says why it kept the old one. Never throws. */
export async function swapSpade(
  version: string,
  mode: SpadeSwapMode,
  ports: SpadeSwapPorts,
): Promise<SpadeSwapResult> {
  let from: string | undefined;
  const failed = (error: string): Failed => ({ kind: "failed", from, to: version, error });
  let state: SpadeServiceState;
  try {
    state = await ports.state();
    if (state === "absent") return { kind: "skipped", reason: "absent" };
    from = await ports.installedVersion();
    if (from === version) return { kind: "skipped", reason: "current" };
  } catch (error) {
    return failed(reason(error));
  }
  // A stopped Spade has no turns to pause; a running one closes admission first.
  let closed = false;
  if (state === "running") {
    try {
      const deadline = spadeDeadlines[mode];
      const until = ports.now() + deadline + spadeDeadlineMarginMs;
      closed = true;
      let status = await ports.closeAdmission(mode, deadline);
      while (!spadeQuiet(mode, status)) {
        if (status.admission !== "closed") throw new Error("Spade reopened admission");
        if (ports.now() >= until)
          throw new Error(
            mode === "idle"
              ? "Spade is still working; it updates once it is idle"
              : "Spade's running model steps didn't finish in time",
          );
        await ports.wait(pollMs);
        status = await ports.maintenance();
      }
    } catch (error) {
      return abort(ports, closed, failed(reason(error)));
    }
  }
  let snapshot: string | undefined;
  try {
    await ports.stage();
    snapshot = await ports.snapshot();
    if (snapshot !== undefined) await ports.checkMigrations(snapshot);
  } catch (error) {
    await drop(ports, snapshot);
    return abort(
      ports,
      closed,
      failed(`Spade ${version} can't open this machine's Spade data: ${reason(error)}`),
    );
  }
  try {
    await ports.flip(version);
  } catch (error) {
    await drop(ports, snapshot);
    return abort(ports, closed, failed(`Couldn't switch Spade to ${version}: ${reason(error)}`));
  }
  try {
    const old = await ports.serverPid();
    await ports.restart();
    if (await ports.health(version, old)) {
      await drop(ports, snapshot);
      return { kind: "swapped", from, to: version };
    }
    throw new Error(`Spade ${version} didn't come up after its restart`);
  } catch (error) {
    const result = await rollBack(ports, from, snapshot, failed(reason(error)));
    await drop(ports, snapshot);
    return result;
  }
}

async function drop(ports: SpadeSwapPorts, snapshot: string | undefined): Promise<void> {
  if (snapshot !== undefined) await ports.removeSnapshot(snapshot).catch(() => {});
}

/** Before the flip: the old Spade still runs, so only admission needs reopening. */
async function abort(
  ports: SpadeSwapPorts,
  closed: boolean,
  result: SpadeSwapResult,
): Promise<SpadeSwapResult> {
  if (closed) await ports.reopenAdmission().catch(() => {});
  return result;
}

/**
 * After the flip: the new version may have migrated the database, which the old one refuses to
 * open. So Spade is stopped, the pre-flip snapshot put back, `current` pointed at the old
 * version and the old Spade started and checked; the result says whether it came back.
 */
async function rollBack(
  ports: SpadeSwapPorts,
  from: string | undefined,
  snapshot: string | undefined,
  result: Failed,
): Promise<Failed> {
  if (from === undefined) return { ...result, error: `${result.error}; no older Spade to restore` };
  try {
    const failedPid = await ports.serverPid();
    await ports.stop();
    if (snapshot !== undefined) await ports.restoreDatabase(snapshot);
    await ports.flip(from);
    await ports.restart();
    const back = await ports.health(from, failedPid);
    return {
      ...result,
      error: back
        ? `${result.error}; Spade ${from} is running again`
        : `${result.error}; Spade ${from} was restored but didn't come back up`,
    };
  } catch (error) {
    return {
      ...result,
      error: `${result.error}; restoring Spade ${from} failed: ${reason(error)}`,
    };
  }
}

/**
 * One release, two programs, never both stopped at once: the daemon is swapped first, then
 * Spade. A daemon update that fails leaves Spade alone; a Spade swap that fails keeps the
 * daemon's update, as each accepts the other's previous version (ADR 0123 decision 5).
 */
export async function swapPrograms<T>(steps: {
  daemon(): Promise<T>;
  spade(): Promise<SpadeSwapResult>;
}): Promise<{ daemon: T; spade: SpadeSwapResult }> {
  const daemon = await steps.daemon();
  return { daemon, spade: await steps.spade() };
}

/** A person-readable line for a Spade swap, or undefined when there is nothing to say. */
export function describeSpadeSwap(result: SpadeSwapResult): string | undefined {
  if (result.kind === "swapped") return `Spade updated to ${result.to}.`;
  if (result.kind === "failed")
    return `Spade stayed at ${result.from ?? "its version"}: ${result.error}`;
  return undefined;
}
