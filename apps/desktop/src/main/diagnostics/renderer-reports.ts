import { DiagnosticReport } from "../../shared/diagnostics.ts";
import type { Log } from "../log/desktop-log.ts";

export interface RendererReportsOptions {
  /** The desktop log's `renderer` component. */
  log: Log;
  now(): number;
  /** Reports written back to back before the limit applies. */
  burst?: number;
  /** One more report is allowed per this many milliseconds, up to `burst`. */
  refillMs?: number;
}

/**
 * The page's diagnostics (`ace.diagnostics.report`) into the desktop log. Each report is
 * parsed again here; a token bucket keeps a page stuck in a loop from filling the size-capped
 * log and rotating away the records around a crash. While reports are dropped one warning
 * says so, and the next report written carries how many were dropped before it.
 * Returns whether the report was written.
 */
export function rendererReports(options: RendererReportsOptions): (payload: unknown) => boolean {
  const burst = options.burst ?? 20;
  const refillMs = options.refillMs ?? 5_000;
  let tokens = burst;
  let refilled = options.now();
  let dropped = 0;
  return (payload) => {
    const report = DiagnosticReport.safeParse(payload);
    if (!report.success) return false;
    const now = options.now();
    const earned = Math.floor((now - refilled) / refillMs);
    if (earned > 0) {
      tokens = Math.min(burst, tokens + earned);
      refilled = tokens === burst ? now : refilled + earned * refillMs;
    }
    if (tokens < 1) {
      if (dropped === 0)
        options.log("warn", "Renderer diagnostics are arriving too fast; dropping them for now");
      dropped++;
      return false;
    }
    tokens--;
    const data = { ...report.data.data, ...(dropped > 0 ? { droppedBefore: dropped } : {}) };
    dropped = 0;
    options.log("info", report.data.event, Object.keys(data).length > 0 ? data : undefined);
    return true;
  };
}
