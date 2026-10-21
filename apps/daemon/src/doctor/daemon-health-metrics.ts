import type { DiagnosticsHealth } from "@ace/protocol";
import { clip, megabytes, milliseconds } from "./daemon-health-format.ts";
import type { Verdict } from "./daemon-health-state.ts";

/** p99 event-loop delay a person feels: clicks and streamed replies lag by a quarter second. */
export const EVENT_LOOP_P99_WARN_MS = 250;
/** One stall this long outlasts the clients' 15 s heartbeat, so open apps drop and reconnect. */
export const EVENT_LOOP_MAX_WARN_MS = 15_000;
/** The daemon normally stays well under 1 GB; past 2 GB something is holding on to memory. */
export const RSS_WARN_BYTES = 2 * 1024 ** 3;
/** Sockets, timers, files and child processes; tens of thousands means something leaks them. */
export const OPEN_HANDLES_WARN = 10_000;
/** A failed log write means the log folder is full or unwritable, so evidence is being lost. */
export const LOG_FAILED_WARN = 1;
/** A burst can drop a few records; hundreds means the log can't keep up and evidence is missing. */
export const LOG_DROPPED_WARN = 100;

/**
 * Backlogs worth a person's attention, by queue. Queues without an entry (for example
 * messages the person queued for a busy agent) are listed but never warned about.
 */
export const QUEUE_WARN: Readonly<Record<string, { at: number; label: Label; bytes?: true }>> = {
  // A thread pauses its provider at 256 waiting frames and caps at 16,384; 4,096 summed
  // across threads means output is piling up faster than it is stored.
  "engine.frames": { at: 4096, label: ["provider output frame", "provider output frames"] },
  // Half of one thread's 16 MB cap.
  "engine.frameBytes": {
    at: 8 * 1024 ** 2,
    label: ["provider output", "provider output"],
    bytes: true,
  },
  // A socket stops being read at 16 waiting messages; 64 means several clients are stuck behind it.
  "daemon.socketInput": { at: 64, label: ["client message", "client messages"] },
};
const QUEUE_LABELS: Readonly<Record<string, Label>> = {
  "engine.queuedSends": ["queued message", "queued messages"],
  "daemon.healthRequests": ["health read", "health reads"],
};
type Label = readonly [one: string, many: string];

const NOT_MEASURED: Verdict = {
  status: "ok",
  message: "Not measured: the daemon sent no health report (see daemon.state)",
  fix: "",
};
const TRIAGE = "Run ace triage to have an agent investigate.";

export function responsivenessVerdict(health: DiagnosticsHealth | undefined): Verdict {
  if (!health) return NOT_MEASURED;
  const { p99Ms, maxMs, meanMs } = health.eventLoop;
  if (p99Ms === null || maxMs === null)
    return { status: "ok", message: "No event-loop samples since the last health read", fix: "" };
  const summary = `p99 ${milliseconds(p99Ms)}, max ${milliseconds(maxMs)}${meanMs === null ? "" : `, mean ${milliseconds(meanMs)}`} since the last health read`;
  const fix = `If ace feels slow, restart it (ace stop, then open ace). ${TRIAGE}`;
  if (maxMs >= EVENT_LOOP_MAX_WARN_MS)
    return {
      status: "warn",
      message: `The daemon froze for ${milliseconds(maxMs)} at once, long enough for open apps to disconnect (${summary})`,
      fix,
    };
  if (p99Ms >= EVENT_LOOP_P99_WARN_MS)
    return { status: "warn", message: `The daemon is lagging: ${summary}`, fix };
  return { status: "ok", message: `Event loop ${summary}`, fix: "" };
}

export function memoryVerdict(health: DiagnosticsHealth | undefined): Verdict {
  if (!health) return NOT_MEASURED;
  const { rssBytes, heapUsedBytes, heapTotalBytes } = health.memory;
  const summary = `${megabytes(rssBytes)} in use (heap ${megabytes(heapUsedBytes)} of ${megabytes(heapTotalBytes)}), ${health.openHandles} open handles`;
  const problems = [
    ...(rssBytes >= RSS_WARN_BYTES ? [`memory is above ${megabytes(RSS_WARN_BYTES)}`] : []),
    ...(health.openHandles >= OPEN_HANDLES_WARN
      ? [`open handles are above ${OPEN_HANDLES_WARN.toLocaleString("en-US")}`]
      : []),
  ];
  return problems.length
    ? {
        status: "warn",
        message: clip(`The daemon may be leaking: ${problems.join(" and ")} (${summary})`),
        fix: `Restarting ace (ace stop, then open ace) frees it. ${TRIAGE}`,
      }
    : { status: "ok", message: summary, fix: "" };
}

export function queuesVerdict(health: DiagnosticsHealth | undefined): Verdict {
  if (!health) return NOT_MEASURED;
  const waiting = Object.entries(health.queues).filter(([, depth]) => depth > 0);
  const backlogged = waiting.filter(([name, depth]) => {
    const limit = QUEUE_WARN[name];
    return limit !== undefined && depth >= limit.at;
  });
  if (backlogged.length)
    return {
      status: "warn",
      message: clip(`Work is piling up: ${backlogged.map(describe).join(", ")} waiting`),
      fix: "Run ace doctor again in a minute. If it hasn't drained, run ace triage to have an agent investigate.",
    };
  return {
    status: "ok",
    message: waiting.length
      ? clip(`Waiting: ${waiting.map(describe).join(", ")}`)
      : "Nothing waiting",
    fix: "",
  };
}

function describe([name, depth]: [string, number]): string {
  const known = QUEUE_WARN[name];
  const [one, many] = known?.label ?? QUEUE_LABELS[name] ?? [name, name];
  return known?.bytes ? `${megabytes(depth)} of ${many}` : `${depth} ${depth === 1 ? one : many}`;
}

export function loggingVerdict(health: DiagnosticsHealth | undefined): Verdict {
  if (!health) return NOT_MEASURED;
  const { failed, dropped, queued, directory } = health.logs;
  const folder = directory ? ` in ${directory}` : "";
  if (failed >= LOG_FAILED_WARN)
    return {
      status: "warn",
      message: clip(
        `${failed} log ${failed === 1 ? "write" : "writes"} failed${dropped ? ` and ${dropped} dropped` : ""} since the daemon started`,
      ),
      fix: clip(`Check free disk space and that the log folder${folder} is writable.`),
    };
  if (dropped >= LOG_DROPPED_WARN)
    return {
      status: "warn",
      message: `${dropped} log records dropped since the daemon started: logging couldn't keep up`,
      fix: TRIAGE,
    };
  return {
    status: "ok",
    message: `Logging keeps up: ${dropped} dropped, ${failed} failed, ${queued} queued`,
    fix: "",
  };
}
