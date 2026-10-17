/** Timers for the reports; the page passes real ones, tests a fake. */
export interface HumanInputClock {
  now(): number;
  set(delayMs: number, run: () => void): () => void;
}

/** The daemon's quiet window is 1.5 s; one report per 250 ms keeps it fed. */
const reportEveryMs = 250;
/**
 * A held button with no events (a native drag-and-drop runs its own loop and the view sees no
 * mouse events until it ends) still counts as the person's, for at most this long since their
 * last event: a release lost to that loop must not keep agents waiting forever.
 */
const holdLimitMs = 30_000;
const buttons = new Set(["leftbuttondown", "middlebuttondown", "rightbuttondown"]);

/**
 * Which of the person's own input on a native view counts as them using the page (ADR 0067,
 * collaboration): every key event, key up and IME composition included, and every mouse event,
 * moves included. A pressed button keeps counting, with reports every 250 ms, until it is
 * released, so an agent never acts in the middle of the person's drag. Agent input never comes
 * here: the page drops what it injected before asking.
 */
export class HumanInputReports {
  private readonly clock: HumanInputClock;
  private readonly report: () => void;
  private last = Number.NEGATIVE_INFINITY;
  private heldSince: number | undefined;
  private stopHeartbeat: (() => void) | undefined;
  constructor(clock: HumanInputClock, report: () => void) {
    this.clock = clock;
    this.report = report;
  }
  /** A key down, up or character, or an IME composition step. */
  key(): void {
    this.seen();
  }
  /** A mouse event with Electron's type and modifiers (which say whether a button is held). */
  mouse(type: string, modifiers: readonly string[] = []): void {
    if (type === "mouseDown") this.hold();
    else if (type === "mouseUp") this.release();
    else if (
      type === "mouseMove" &&
      !modifiers.some((modifier) => buttons.has(modifier.toLowerCase()))
    )
      this.release();
    else if (this.heldSince !== undefined) this.heldSince = this.clock.now();
    this.seen();
  }
  close(): void {
    this.release();
  }
  private seen(): void {
    const now = this.clock.now();
    if (now - this.last < reportEveryMs) return;
    this.last = now;
    this.report();
  }
  private hold(): void {
    this.heldSince = this.clock.now();
    if (this.stopHeartbeat) return;
    const beat = () => {
      const since = this.heldSince;
      if (since === undefined || this.clock.now() - since >= holdLimitMs) {
        this.release();
        return;
      }
      this.seen();
      this.stopHeartbeat = this.clock.set(reportEveryMs, beat);
    };
    this.stopHeartbeat = this.clock.set(reportEveryMs, beat);
  }
  private release(): void {
    this.heldSince = undefined;
    this.stopHeartbeat?.();
    this.stopHeartbeat = undefined;
  }
}
