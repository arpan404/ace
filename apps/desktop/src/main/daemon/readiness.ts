import type { LocalDaemon } from "./probe.ts";

/** How often a start looks for the daemon's endpoint and asks for its admission again. */
const POLL_MS = 200;
/**
 * While the endpoint file is watched, a change wakes the lookup at once; this is only the
 * fallback, for a change the watch missed.
 */
const WATCHED_POLL_MS = 1_000;

/** Changes to the home's `daemon-endpoint`, which a daemon writes once it listens. */
export interface EndpointWatch {
  /** Settles on the next change, or at once for one since the last call. */
  changed(): Promise<void>;
  close(): void;
}

export interface ReadinessPorts {
  find(): Promise<LocalDaemon | undefined>;
  /** Watches the endpoint file while a start waits; undefined where it cannot be watched. */
  watchEndpoint?: (() => EndpointWatch | undefined) | undefined;
  maintenance(
    daemon: LocalDaemon,
  ): Promise<{ draining: boolean; holds?: readonly string[] | undefined }>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  now(): number;
  log(level: "warn", message: string, data?: Record<string, unknown>): void;
}

const pause = (ports: ReadinessPorts) =>
  new Promise<void>((resolve) => ports.timers.set(POLL_MS, resolve));

/** The next endpoint change, or the fallback poll, whichever comes first. */
function nextChange(ports: ReadinessPorts, watch: EndpointWatch): Promise<void> {
  return new Promise((resolve) => {
    const cancel = ports.timers.set(WATCHED_POLL_MS, resolve);
    void watch.changed().then(() => {
      cancel();
      resolve();
    });
  });
}

/**
 * Look for a daemon serving this home until one answers, `live` turns false (the start was
 * superseded, or our child exited) or `timeoutMs` passes. Each lookup reads the home's files
 * and asks the daemon's status, so where the endpoint file can be watched the next lookup
 * waits for it to change (a daemon writes it once it listens), with a slow poll behind that.
 */
export async function waitForDaemon(
  ports: ReadinessPorts,
  timeoutMs: number,
  live: () => boolean,
): Promise<LocalDaemon | undefined> {
  const deadline = ports.now() + timeoutMs;
  const watch = ports.watchEndpoint?.();
  try {
    while (live() && ports.now() < deadline) {
      const found = await ports.find();
      if (found) return found;
      await (watch ? nextChange(ports, watch) : pause(ports));
    }
  } finally {
    watch?.close();
  }
  return undefined;
}

/** A found daemon's admission: read, unreadable past the deadline, or no longer wanted. */
export type Admission =
  /** `paused`: the person paused new work; an update or kill-all holding admission isn't that. */
  { kind: "read"; paused: boolean } | { kind: "failed"; reason: string } | { kind: "abandoned" };

/**
 * Ask a found daemon whether it admits new work, retrying while it is still coming up. The
 * daemon only counts as running once this is known, so the app never shows it unpaused while
 * it drains.
 */
export async function readAdmission(
  ports: ReadinessPorts,
  daemon: LocalDaemon,
  timeoutMs: number,
  live: () => boolean,
): Promise<Admission> {
  const deadline = ports.now() + timeoutMs;
  while (live()) {
    try {
      const admission = await ports.maintenance(daemon);
      return { kind: "read", paused: personPaused(admission) };
    } catch (error) {
      if (!live()) break;
      if (ports.now() >= deadline)
        return { kind: "failed", reason: `Cannot read daemon admission: ${String(error)}` };
      ports.log("warn", "Cannot read daemon admission yet", { error: String(error) });
      await pause(ports);
    }
  }
  return { kind: "abandoned" };
}

/** Whether the person paused new work; daemons that predate holds only say it is closed. */
export function personPaused(admission: {
  draining: boolean;
  holds?: readonly string[] | undefined;
}): boolean {
  return admission.holds ? admission.holds.includes("user") : admission.draining;
}
