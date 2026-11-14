import type { InFlightWork } from "./grants.ts";
import type { HungCause } from "./health.ts";
import type { MediaHealth } from "./supervision-policy.ts";
import type { FromMedia } from "./wire.ts";

/** What the supervisor reports about ace-media: exits, snapshots and its stderr. */

export type MediaCapabilities = Extract<FromMedia, { type: "ready" }>["capabilities"];
export type MediaStats = Extract<FromMedia, { type: "pong" }>["stats"];
export type MediaLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: unknown,
) => void;

export type ExitCause =
  | "crashed"
  | "ready-timeout"
  | "version-mismatch"
  | HungCause
  | "revocation-timeout"
  | "lane-closed"
  | "protocol"
  | "idle"
  | "disposed";

/** What a process exit took with it, for the owners of that state to fail or replay. */
export type MediaExit = InFlightWork & {
  cause: ExitCause;
  code: number | null;
  signal: string | null;
  /** Counted toward backoff and the crash-loop window. */
  failure: boolean;
  restartInMs?: number | undefined;
};

export type MediaPhase =
  | "disabled"
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "backoff"
  | "unavailable";

export type MediaSnapshot = {
  health: MediaHealth;
  phase: MediaPhase;
  pid?: number | undefined;
  capabilities?: MediaCapabilities | undefined;
  stats?: MediaStats | undefined;
  recentFailures: number;
  unavailableUntil?: number | undefined;
  unavailableReason?: string | undefined;
  lastExit?:
    | { cause: ExitCause; code: number | null; signal: string | null; stderr: string[] }
    | undefined;
};

export function phaseHealth(phase: MediaPhase): MediaHealth {
  if (phase === "running") return "healthy";
  return phase === "disabled" || phase === "unavailable" ? "unavailable" : "restarting";
}

const keptLines = 20;
const linesPerSecond = 20;
const maxLine = 4096;

/**
 * ace-media's stderr: the last lines kept for diagnostics, and lines passed to the daemon's
 * log at most 20 a second, with a count of those suppressed.
 */
export class StderrLog {
  readonly lines: string[] = [];
  readonly #decoder = new TextDecoder();
  readonly #now: () => number;
  readonly #log: MediaLog;
  #partial = "";
  #window = { start: Number.NEGATIVE_INFINITY, lines: 0, suppressed: 0 };

  constructor(now: () => number, log: MediaLog) {
    this.#now = now;
    this.#log = log;
  }

  push(chunk: Uint8Array): void {
    const lines = (this.#partial + this.#decoder.decode(chunk, { stream: true })).split("\n");
    this.#partial = lines.pop() ?? "";
    for (const line of lines) this.#line(line.slice(0, maxLine));
  }

  #line(line: string): void {
    this.lines.push(line);
    if (this.lines.length > keptLines) this.lines.shift();
    const now = this.#now();
    if (now - this.#window.start >= 1_000) {
      if (this.#window.suppressed > 0)
        this.#log("warn", "ace-media stderr lines suppressed", { count: this.#window.suppressed });
      this.#window = { start: now, lines: 0, suppressed: 0 };
    }
    if (this.#window.lines++ < linesPerSecond) this.#log("info", "ace-media stderr", { line });
    else this.#window.suppressed++;
  }
}
