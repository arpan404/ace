import type { PressureVerdict } from "@ace/diagnostics/pressure";

/**
 * What the daemon's own stall watchdog last wrote about the stall it is in (`stall-<pid>.json`),
 * reduced to what the decision needs.
 */
export interface StallReading {
  silentMs: number;
  /** Process CPU used during the silence. */
  cpuMs?: number | undefined;
  /** How late the watchdog thread's own checks ran: the whole process got no CPU. */
  watchdogLateMs?: number | undefined;
  /** Since the watchdog last rewrote the report (it does every 2 s while a stall lasts). */
  ageMs: number;
}

/**
 * Why the daemon's event loop is silent, by its watchdog's numbers:
 * - `starved`: it used little CPU and the OS gave it none (its watchdog ran late, or the
 *   machine is under pressure). Not hung: it carries on once it is scheduled.
 * - `busy`: it used CPU for nearly all of the silence: computing, possibly forever.
 * - `waiting`: little CPU on a calm machine: blocked in native code (a lock, sync I/O).
 * - `stale`: the report is old; the watchdog thread itself stopped writing.
 */
export type StallKind = "starved" | "busy" | "waiting" | "stale";

/** A report the watchdog has not rewritten for this long says nothing about now. */
const STALE_MS = 30_000;

export function stallKind(stall: StallReading, pressure: PressureVerdict | undefined): StallKind {
  if (stall.ageMs > STALE_MS) return "stale";
  const cpu = stall.cpuMs ?? 0;
  if (stall.cpuMs !== undefined && cpu >= stall.silentMs * 0.8) return "busy";
  const late = (stall.watchdogLateMs ?? 0) >= 1_000;
  if (cpu < stall.silentMs * 0.5 && (late || pressure?.heavy === true)) return "starved";
  return "waiting";
}

export interface GracePolicy {
  /** The first grace after the normal missed checks; each later one doubles. */
  baseMs: number;
  /** No single grace is longer. */
  maxMs: number;
  /** Unanswered this long, the daemon is stopped whatever the machine says. */
  ceilingMs: number;
}
export const defaultGrace: GracePolicy = { baseMs: 15_000, maxMs: 120_000, ceilingMs: 300_000 };

export interface UnresponsiveFacts {
  /** Since the daemon last answered a health check. */
  unansweredMs: number;
  /** Graces already given since it last answered. */
  graces: number;
  /** Undefined when the machine's load could not be read. */
  pressure: PressureVerdict | undefined;
  /** Undefined when the daemon reports no stall (or an older daemon wrote none). */
  stall: StallReading | undefined;
}

export type HealthVerdict =
  | { kind: "stop"; why: string }
  | { kind: "wait"; graceMs: number; why: string };

/**
 * The daemon missed its health checks: stop it, or give it longer (ADR 0196). A daemon on a
 * machine that starves it is slow, not hung, and stopping it interrupts every agent it runs and
 * the restart competes for the same CPU. It is stopped when it is silent with CPU to spare
 * (busy forever, or blocked on a calm machine), or once it has been silent past the ceiling.
 */
export function healthVerdict(
  facts: UnresponsiveFacts,
  policy: GracePolicy = defaultGrace,
): HealthVerdict {
  if (facts.unansweredMs >= policy.ceilingMs)
    return { kind: "stop", why: "silent past the ceiling" };
  const kind = facts.stall ? stallKind(facts.stall, facts.pressure) : undefined;
  const graceMs = Math.min(policy.maxMs, policy.baseMs * 2 ** facts.graces);
  if (kind === "starved") return { kind: "wait", graceMs, why: "starved of CPU, not hung" };
  if (facts.pressure?.heavy) return { kind: "wait", graceMs, why: "the machine is overloaded" };
  if (kind === "busy") return { kind: "stop", why: "busy on a calm machine" };
  return { kind: "stop", why: "silent on a calm machine" };
}

export interface StartupFacts {
  /** Since the daemon was spawned. */
  waitedMs: number;
  /** The daemon wrote something since the last look (its log, its startup record, a stall). */
  progressed: boolean;
  pressure: PressureVerdict | undefined;
}

/** A start that neither answers nor shows progress for this long is stopped anyway. */
export const startupCeilingMs = 15 * 60_000;
/** How much longer a start that is still getting somewhere is given, each time. */
export const startupExtensionMs = 60_000;

/**
 * The daemon has not answered within its ready budget: stop it as not ready, or wait longer. A
 * daemon still writing its log or startup record is starting, and one on an overloaded machine
 * is slow; stopping either only starts the same work again from the beginning.
 */
export function startupVerdict(facts: StartupFacts): HealthVerdict {
  if (facts.waitedMs >= startupCeilingMs)
    return { kind: "stop", why: "not ready past the ceiling" };
  if (facts.progressed)
    return { kind: "wait", graceMs: startupExtensionMs, why: "still making startup progress" };
  if (facts.pressure?.heavy)
    return { kind: "wait", graceMs: startupExtensionMs, why: "the machine is overloaded" };
  return { kind: "stop", why: "no startup progress on a calm machine" };
}

/**
 * The wait before restarting a daemon that exited: the crash backoff on a calm machine; on an
 * overloaded one, at least 5 s doubling to 2 minutes, so restarts do not pile more startup work
 * on a machine that is already starving.
 */
export function restartBackoff(crashDelayMs: number, attempt: number, pressured: boolean): number {
  if (!pressured) return crashDelayMs;
  return Math.max(crashDelayMs, Math.min(120_000, 5_000 * 2 ** Math.max(0, attempt)));
}
