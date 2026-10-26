import type { LockedUseObservation, LockedUseStatus } from "@ace/protocol";
import type { LockedUseInstaller } from "./locked-use.ts";
import {
  detectLockedUse,
  type LockedUseDetection,
  type LockedUseExpectation,
} from "./locked-use-detect.ts";
import type { MacHost } from "./locked-use-host.ts";

/**
 * The privileged step: installs or removes the plug-in, the rule alternative and both root
 * daemons. One call is one administrator authorization. Its result is never trusted; the
 * installer re-detects afterwards.
 */
export interface PrivilegedRunner {
  install(): Promise<void>;
  remove(): Promise<void>;
}

/** Runs `tick` every `intervalMs` until the returned stop function runs. */
export type LockedUseScheduler = (intervalMs: number, tick: () => void) => () => void;

export interface MacLockedUseOptions {
  host: MacHost;
  runner: PrivilegedRunner;
  expect: LockedUseExpectation;
  /** The person's `computer.lockedUse` setting. */
  readIntent(): Promise<boolean>;
  schedule: LockedUseScheduler;
  /** How often subscribers re-detect; default one minute. */
  intervalMs?: number;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function failure(detection: LockedUseDetection, fallback: string): string {
  const status = detection.status;
  return "reason" in status && typeof status.reason === "string" && status.reason
    ? status.reason
    : fallback;
}

/**
 * Locked use on macOS: status is always what read-only detection proves, and every change goes
 * through the injected privileged runner, then is verified by detecting again. It fails closed:
 * nothing reports `on` unless detection found every component valid.
 *
 * Revisions come from one counter and are taken when an observation starts, so a detection
 * that began before an install finished carries the lower revision and is dropped downstream.
 */
export function macLockedUseInstaller(options: MacLockedUseOptions): LockedUseInstaller {
  const { host, runner, expect, schedule } = options;
  const intervalMs = options.intervalMs ?? 60_000;
  const listeners = new Set<(observation: LockedUseObservation) => void>();
  let stopSchedule: (() => void) | undefined;
  let nextRevision = 0;
  /** The newest observation recorded, and its status encoded for change checks. */
  let newest: { revision: number; encoded: string } | undefined;
  let acting = false;
  let detecting = false;
  let lastDetectAt: number | undefined;

  /** Records an observation; listeners hear it only if it is newest and the status changed. */
  const observe = (revision: number, status: LockedUseStatus): LockedUseObservation => {
    const observation = { revision, status };
    if (newest && revision <= newest.revision) return observation;
    const encoded = JSON.stringify(status);
    const changed = newest?.encoded !== encoded;
    newest = { revision, encoded };
    if (changed) for (const listener of listeners) listener(observation);
    return observation;
  };

  const detect = async (): Promise<{ revision: number; detection: LockedUseDetection }> => {
    const revision = nextRevision++;
    const intent = await options.readIntent().catch(() => false);
    const detection = await detectLockedUse(host, expect, intent);
    lastDetectAt = host.now();
    return { revision, detection };
  };

  const tick = () => {
    if (acting || detecting) return;
    if (lastDetectAt !== undefined && host.now() - lastDetectAt < intervalMs / 2) return;
    detecting = true;
    void detect()
      .then(({ revision, detection }) => observe(revision, detection.status))
      .catch(() => {})
      .finally(() => {
        detecting = false;
      });
  };

  /** Runner install, then proof: anything short of a detected `on` is a failed install. */
  const installAndVerify = async (): Promise<LockedUseObservation> => {
    let thrown: unknown;
    try {
      await runner.install();
    } catch (error) {
      thrown = error;
    }
    const { revision, detection } = await detect();
    if (thrown !== undefined)
      return observe(revision, {
        state: "installFailed",
        reason: message(thrown, "The install didn't finish."),
      });
    if (detection.status.state === "on") return observe(revision, detection.status);
    return observe(revision, {
      state: "installFailed",
      reason: failure(detection, "Locked use still isn't fully installed after the install."),
    });
  };

  /** Runner remove, then proof: anything of ours left behind is drift. */
  const removeAndVerify = async (): Promise<LockedUseObservation> => {
    let thrown: unknown;
    try {
      await runner.remove();
    } catch (error) {
      thrown = error;
    }
    const { revision, detection } = await detect();
    if (!detection.residue) return observe(revision, { state: "off" });
    const reason = failure(detection, "Part of locked use is still installed.");
    return observe(revision, {
      state: "driftRepairNeeded",
      reason: thrown === undefined ? reason : message(thrown, reason),
    });
  };

  const act = async (work: () => Promise<LockedUseObservation>): Promise<LockedUseObservation> => {
    if (acting) throw new Error("Another locked use change is running.");
    acting = true;
    try {
      observe(nextRevision++, { state: "installing" });
      return await work();
    } finally {
      acting = false;
    }
  };

  return {
    async detectStatus() {
      // Mid-change the Mac is half-installed by design; report the change, not drift.
      if (acting) return observe(nextRevision++, { state: "installing" });
      const { revision, detection } = await detect();
      return observe(revision, detection.status);
    },
    install: () => act(installAndVerify),
    remove: () => act(removeAndVerify),
    async repair() {
      const before = await detect();
      if (before.detection.status.state === "on")
        return observe(before.revision, before.detection.status);
      return act(async () => {
        if (!before.detection.residue) return installAndVerify();
        const cleared = await removeAndVerify();
        return cleared.status.state === "off" ? installAndVerify() : cleared;
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      stopSchedule ??= schedule(intervalMs, tick);
      return () => {
        listeners.delete(listener);
        if (listeners.size || !stopSchedule) return;
        stopSchedule();
        stopSchedule = undefined;
      };
    },
  };
}
