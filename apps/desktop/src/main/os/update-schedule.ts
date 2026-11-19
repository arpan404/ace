import type { CheckOrigin } from "./update-controller.ts";

export interface UpdateSchedule {
  /** The launch check, this long after the daemon first runs: it never competes with the start. */
  afterDaemonMs: number;
  /**
   * The launch check's latest moment, for a daemon that never comes up: an update may be what
   * fixes it.
   */
  launchLatestMs: number;
  /** Between checks while the app is in use. */
  everyMs: number;
  /** Between checks while the window is hidden or the computer runs on battery. */
  idleEveryMs: number;
  /** Each wait grows by a random part of up to this share of itself (0.5: up to half). */
  spread: number;
  /** Opening or focusing the app checks at once unless a check started this recently. */
  openGapMs: number;
}

/** Launch after daemon readiness, then every four to six hours with jitter. */
export const updateSchedule: UpdateSchedule = {
  afterDaemonMs: 5_000,
  launchLatestMs: 60_000,
  everyMs: 4 * 60 * 60_000,
  idleEveryMs: 4 * 60 * 60_000,
  spread: 0.5,
  openGapMs: 4 * 60 * 60_000,
};

export interface CheckSchedulePorts {
  timers: { set(delayMs: number, callback: () => void): () => void };
  /** A number in [0, 1): each wait's offset. */
  random(): number;
  now(): number;
  /** True while the person can see the app's window and the computer runs on mains power. */
  active(): boolean;
  /** Settles once the daemon first runs. */
  daemonRunning: Promise<unknown>;
}

export interface CheckSchedule {
  /**
   * The app was opened or focused, or the computer woke or was plugged in: check now (unless one
   * just started, or the launch check is still to come) and wait a full period after.
   */
  opened(): void;
  cancel(): void;
}

/** Background checks of `checker` on `schedule`. */
export function scheduleChecks(
  checker: { check(origin: CheckOrigin): Promise<unknown> },
  ports: CheckSchedulePorts,
  schedule: UpdateSchedule = updateSchedule,
): CheckSchedule {
  const wait = (baseMs: number) => {
    const share = Math.max(0, Math.min(1, ports.random()));
    return Math.round(baseMs * (1 + schedule.spread * share));
  };
  let cancelled = false;
  let lastCheck: number | undefined;
  const tick = () => {
    lastCheck = ports.now();
    // check() logs a background failure and keeps the status it had.
    void checker.check("background").catch(() => {});
    cancel = ports.timers.set(wait(ports.active() ? schedule.everyMs : schedule.idleEveryMs), tick);
  };
  const launchedAt = ports.now();
  let cancel = ports.timers.set(schedule.launchLatestMs, tick);
  // daemonRunning settles either way; a failure here leaves the launch deadline above.
  void ports.daemonRunning
    .then(() => {
      if (cancelled || lastCheck !== undefined) return;
      // The earlier of the launch deadline and a few seconds after the daemon runs.
      const deadlineIn = launchedAt + schedule.launchLatestMs - ports.now();
      if (deadlineIn <= schedule.afterDaemonMs) return;
      cancel();
      cancel = ports.timers.set(schedule.afterDaemonMs, tick);
    })
    .catch(() => {});
  return {
    opened() {
      if (cancelled || lastCheck === undefined) return;
      if (ports.now() - lastCheck < schedule.openGapMs) return;
      cancel();
      tick();
    },
    cancel() {
      cancelled = true;
      cancel();
    },
  };
}
