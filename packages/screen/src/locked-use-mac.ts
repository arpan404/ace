import type { LockedUseStatus } from "@ace/protocol";
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
 */
export function macLockedUseInstaller(options: MacLockedUseOptions): LockedUseInstaller {
  const { host, runner, expect, schedule } = options;
  const intervalMs = options.intervalMs ?? 60_000;
  const listeners = new Set<(status: LockedUseStatus) => void>();
  let stopSchedule: (() => void) | undefined;
  let last: string | undefined;
  let acting = false;
  let detecting = false;
  let lastDetectAt: number | undefined;

  const publish = (status: LockedUseStatus) => {
    const encoded = JSON.stringify(status);
    if (encoded === last) return;
    last = encoded;
    for (const listener of listeners) listener(status);
  };

  const detect = async (): Promise<LockedUseDetection> => {
    const intent = await options.readIntent().catch(() => false);
    const detection = await detectLockedUse(host, expect, intent);
    lastDetectAt = host.now();
    return detection;
  };

  const tick = () => {
    if (acting || detecting) return;
    if (lastDetectAt !== undefined && host.now() - lastDetectAt < intervalMs / 2) return;
    detecting = true;
    void detect()
      .then((detection) => {
        if (!acting) publish(detection.status);
      })
      .catch(() => {})
      .finally(() => {
        detecting = false;
      });
  };

  /** Runner install, then proof: anything short of a detected `on` is a failed install. */
  const installAndVerify = async (): Promise<LockedUseStatus> => {
    let thrown: unknown;
    try {
      await runner.install();
    } catch (error) {
      thrown = error;
    }
    const detection = await detect();
    if (thrown !== undefined)
      return { state: "installFailed", reason: message(thrown, "The install didn't finish.") };
    if (detection.status.state === "on") return detection.status;
    return {
      state: "installFailed",
      reason: failure(detection, "Locked use still isn't fully installed after the install."),
    };
  };

  /** Runner remove, then proof: anything of ours left behind is drift. */
  const removeAndVerify = async (): Promise<LockedUseStatus> => {
    let thrown: unknown;
    try {
      await runner.remove();
    } catch (error) {
      thrown = error;
    }
    const detection = await detect();
    if (!detection.residue) return { state: "off" };
    const reason = failure(detection, "Part of locked use is still installed.");
    return {
      state: "driftRepairNeeded",
      reason: thrown === undefined ? reason : message(thrown, reason),
    };
  };

  const act = async (work: () => Promise<LockedUseStatus>): Promise<LockedUseStatus> => {
    if (acting) throw new Error("Another locked use change is running.");
    acting = true;
    try {
      publish({ state: "installing" });
      const status = await work();
      publish(status);
      return status;
    } finally {
      acting = false;
    }
  };

  return {
    async detectStatus() {
      const { status } = await detect();
      if (!acting) publish(status);
      return status;
    },
    install: () => act(installAndVerify),
    remove: () => act(removeAndVerify),
    async repair() {
      const before = await detect();
      if (before.status.state === "on") {
        publish(before.status);
        return before.status;
      }
      return act(async () => {
        if (!before.residue) return installAndVerify();
        const cleared = await removeAndVerify();
        return cleared.state === "off" ? installAndVerify() : cleared;
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
        last = undefined;
      };
    },
  };
}
