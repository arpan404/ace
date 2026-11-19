/*
 * The pace a streaming message reaches its renderer. Every update can grow the message's row,
 * and a growing row re-measures the transcript, follows the live end and lays the page out
 * again, so a streaming message changes 10 to 20 times a second (`cadence.ts`) rather than once
 * a frame. Finished text is never held back.
 */

export interface StreamPaceDeps {
  now(): number;
  /** Runs `run` after `delayMs`; returns a cancel. */
  schedule(delayMs: number, run: () => void): () => void;
  /** Milliseconds between updates, given how long the last one took to apply. */
  interval(lastMs: number): number;
  /** Renders `text`; settles once it is on screen (or replaced). */
  send(text: string, finalized: boolean): Promise<unknown>;
}

export class StreamPace {
  private readonly deps: StreamPaceDeps;
  private sent: { text: string; finalized: boolean } | undefined;
  private pending: { text: string; finalized: boolean } | undefined;
  private busy = false;
  private nextAt = 0;
  private cancel: (() => void) | undefined;
  private disposed = false;

  constructor(deps: StreamPaceDeps) {
    this.deps = deps;
  }

  /** The message's latest text. Streaming text waits for its turn; finished text goes now. */
  push(text: string, finalized: boolean): void {
    if (this.disposed) return;
    this.pending = { text, finalized };
    if (finalized) {
      this.cancel?.();
      this.cancel = undefined;
      this.nextAt = 0;
    }
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel?.();
    this.cancel = undefined;
    this.pending = undefined;
  }

  private pump(): void {
    const next = this.pending;
    if (this.disposed || this.busy || this.cancel || !next) return;
    if (this.sent && this.sent.text === next.text && this.sent.finalized === next.finalized) {
      this.pending = undefined;
      return;
    }
    const wait = next.finalized ? 0 : this.nextAt - this.deps.now();
    if (wait > 0) {
      this.cancel = this.deps.schedule(wait, () => {
        this.cancel = undefined;
        this.pump();
      });
      return;
    }
    this.pending = undefined;
    this.sent = next;
    this.busy = true;
    const started = this.deps.now();
    const settle = () => {
      this.busy = false;
      const took = this.deps.now() - started;
      this.nextAt = started + this.deps.interval(took);
      this.pump();
    };
    this.deps.send(next.text, next.finalized).then(settle, settle);
  }
}
