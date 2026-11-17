import { z } from "zod";
import type { AttemptFile } from "./startup-attempts.ts";

/*
 * Which service's code was running when the daemon died of a fatal error, kept across runs. A
 * service that crashed the daemon twice within a short window is left off by the next safe-mode
 * start, as one whose start never finished is (ADR 0175). The rules are pure; the file and the
 * process listener are the thin shell around them.
 */

export interface Crash {
  service: string;
  at: number;
}

/** Two crashes by one service within this window say it is the one that keeps failing. */
export const crashWindowMs = 10 * 60_000;
export const crashesToLeaveOff = 2;
const kept = 32;

const Stored = z.object({
  crashes: z.array(z.object({ service: z.string().max(200), at: z.number().finite() })).max(256),
});

/** The record with one more crash, without those too old to count. */
export function withCrash(crashes: readonly Crash[], crash: Crash): Crash[] {
  return [...crashes, crash].filter(({ at }) => crash.at - at <= crashWindowMs).slice(-kept);
}

/** Services that crashed the daemon at least twice within the window before `now`. */
export function repeatedCrashes(crashes: readonly Crash[], now: number): string[] {
  const counts = new Map<string, number>();
  for (const { service, at } of crashes)
    if (at <= now && now - at <= crashWindowMs) counts.set(service, (counts.get(service) ?? 0) + 1);
  return [...counts].filter(([, count]) => count >= crashesToLeaveOff).map(([service]) => service);
}

export interface CrashRecord {
  /** Crashes the earlier runs recorded. */
  previous: readonly Crash[];
  /** Records a crash in `service`'s code; synchronous, for a process about to die. */
  record(service: string, at: number): void;
}

export function crashRecord(file: AttemptFile): CrashRecord {
  let crashes: Crash[] = [];
  try {
    const text = file.read();
    const parsed = text === undefined ? undefined : Stored.safeParse(JSON.parse(text));
    if (parsed?.success) crashes = parsed.data.crashes;
  } catch {
    // Damaged or unreadable: no earlier crash is known.
  }
  const previous = [...crashes];
  return {
    previous,
    record(service, at) {
      crashes = withCrash(crashes, { service, at });
      try {
        file.write(JSON.stringify({ crashes }));
      } catch {
        // A full or read-only disk only costs safe mode its precision.
      }
    },
  };
}

export interface CrashEvents {
  on(event: "uncaughtExceptionMonitor", listener: (error: unknown) => void): unknown;
  off(event: "uncaughtExceptionMonitor", listener: (error: unknown) => void): unknown;
}

/**
 * Charges each fatal error to the service whose code raised it, when that is known. An
 * unhandled rejection reaches here too: the rejection guard rethrows it from a timer, which
 * carries the rejection's context where the runtime keeps it.
 */
export function installCrashAttribution(
  events: CrashEvents,
  owner: () => string | undefined,
  record: (service: string) => void,
): () => void {
  const fatal = () => {
    const service = owner();
    if (service !== undefined) record(service);
  };
  events.on("uncaughtExceptionMonitor", fatal);
  return () => events.off("uncaughtExceptionMonitor", fatal);
}
