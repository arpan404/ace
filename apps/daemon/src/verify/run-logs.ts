import { appendTail, type LogTail } from "./log-tail.ts";
import type { VerifyRuns } from "./run-store.ts";

/**
 * Live runs' output: lines collect in memory and reach the store at most once per
 * `flushMs`, and whenever someone reads the log or the run settles.
 */
export class RunLogs {
  private readonly runs: VerifyRuns;
  private readonly flushMs: number;
  private readonly live = new Map<string, { tail: LogTail; dirty: boolean }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(runs: VerifyRuns, flushMs = 1_000) {
    this.runs = runs;
    this.flushMs = flushMs;
  }

  line(runId: string, text: string): void {
    const entry = this.live.get(runId) ?? { tail: this.runs.log(runId), dirty: false };
    entry.tail = appendTail(entry.tail, `${text}\n`);
    entry.dirty = true;
    this.live.set(runId, entry);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  read(runId: string): LogTail {
    return this.live.get(runId)?.tail ?? this.runs.log(runId);
  }

  /** Write the run's output and stop holding it. */
  finish(runId: string): void {
    const entry = this.live.get(runId);
    if (entry?.dirty) this.runs.saveLog(runId, entry.tail);
    this.live.delete(runId);
  }

  flush(): void {
    for (const [runId, entry] of this.live) {
      if (!entry.dirty) continue;
      this.runs.saveLog(runId, entry.tail);
      entry.dirty = false;
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
    this.live.clear();
  }
}
