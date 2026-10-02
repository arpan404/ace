import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

import type { Frame, FrameDirection } from "@ace/engine-api";
export type { Frame, FrameDirection } from "@ace/engine-api";

export type RecordingHeader = {
  format: "ace-recording/v1";
  provider: string;
  cliVersion: string;
  scenario: string;
  startedAt: string;
  platform: string;
  workspace: string;
};

/**
 * Append-only JSONL writer for one scenario run. Also tracks the last
 * "activity" time so the runner can tell when the provider went quiet.
 */
export class Recording {
  readonly #out: WriteStream;
  readonly #start = performance.now();
  #seq = 0;
  #lastActivity = performance.now();
  readonly #marks = new Map<string, number>();

  constructor(path: string, header: RecordingHeader) {
    mkdirSync(dirname(path), { recursive: true });
    this.#out = createWriteStream(path, { flags: "w" });
    this.#out.write(`${JSON.stringify(header)}\n`);
  }

  /** Record a frame. `activity: false` for heartbeats and other noise. */
  frame(dir: FrameDirection, channel: string, data: unknown, activity = true): void {
    const now = performance.now();
    const frame: Frame = {
      seq: this.#seq++,
      t: Math.round(now - this.#start),
      dir,
      channel,
      data,
    };
    this.#out.write(`${JSON.stringify(frame)}\n`);
    if (activity) this.#lastActivity = now;
  }

  note(event: string, detail?: unknown): void {
    this.frame("note", "recorder", detail === undefined ? { event } : { event, detail });
  }

  /** Count a named milestone (e.g. `turn-end`) and record it as a note. */
  mark(name: string, detail?: unknown): void {
    this.#marks.set(name, (this.#marks.get(name) ?? 0) + 1);
    this.note(name, detail);
  }

  marks(name: string): number {
    return this.#marks.get(name) ?? 0;
  }

  quietForMs(): number {
    return performance.now() - this.#lastActivity;
  }

  elapsedMs(): number {
    return performance.now() - this.#start;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#out.end(resolve));
  }
}
