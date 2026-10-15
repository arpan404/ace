import type { LocalDaemon } from "./probe.ts";

/** How often a start looks for the daemon's endpoint and asks for its admission again. */
const POLL_MS = 200;

export interface ReadinessPorts {
  find(): Promise<LocalDaemon | undefined>;
  maintenance(daemon: LocalDaemon): Promise<{ draining: boolean }>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  now(): number;
  log(level: "warn", message: string, data?: Record<string, unknown>): void;
}

const pause = (ports: ReadinessPorts) =>
  new Promise<void>((resolve) => ports.timers.set(POLL_MS, resolve));

/**
 * Look for a daemon serving this home until one answers, `live` turns false (the start was
 * superseded, or our child exited) or `timeoutMs` passes.
 */
export async function waitForDaemon(
  ports: ReadinessPorts,
  timeoutMs: number,
  live: () => boolean,
): Promise<LocalDaemon | undefined> {
  const deadline = ports.now() + timeoutMs;
  while (live() && ports.now() < deadline) {
    const found = await ports.find();
    if (found) return found;
    await pause(ports);
  }
  return undefined;
}

/** A found daemon's admission: read, unreadable past the deadline, or no longer wanted. */
export type Admission =
  | { kind: "read"; draining: boolean }
  | { kind: "failed"; reason: string }
  | { kind: "abandoned" };

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
      const { draining } = await ports.maintenance(daemon);
      return { kind: "read", draining };
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
