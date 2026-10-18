import type { Schedule } from "./cdp-connection.ts";

interface WindowOpen {
  windowName?: string | undefined;
  windowFeatures?: readonly string[] | undefined;
}
const severing = new Set(["noopener", "noreferrer"]);

/** A named window or one with features opens as a window of its own in a person's tab. */
export function opensWindow(open: WindowOpen): boolean {
  const named =
    open.windowName !== undefined && open.windowName !== "" && !open.windowName.startsWith("_");
  return named || (open.windowFeatures?.length ?? 0) > 0;
}

/**
 * Whether the opened page keeps `window.opener`: a sized or named popup is how sign-in flows
 * such as OAuth open, and they talk back through it. A plain new-tab link (`_blank`, which
 * implies `noopener`) can load in the opener's own page instead.
 */
export function needsOpener(open: WindowOpen): boolean {
  const features = open.windowFeatures ?? [];
  if (features.some((feature) => severing.has(feature.trim().toLowerCase()))) return false;
  const named =
    open.windowName !== undefined && open.windowName !== "" && !open.windowName.startsWith("_");
  return named || features.length > 0;
}

/** One `window.open` of a page: whether it loads in the opener's page, and where it goes. */
export interface PopupKind {
  reuse: boolean;
  url: string;
}

/**
 * Pairs a page's `window.open` events with the popup targets the browser creates for them, in
 * order, whichever arrives first. A target that comes first waits (it is paused) for its event;
 * one that never gets an event is decided without a kind after `waitMs`.
 */
export class PopupPairing<T> {
  private kinds: PopupKind[] = [];
  private waiting: { target: T; cancel(): void }[] = [];
  private schedule: Schedule;
  private decide: (target: T, kind: PopupKind | undefined) => void;
  private waitMs: number;
  constructor(
    schedule: Schedule,
    decide: (target: T, kind: PopupKind | undefined) => void,
    waitMs = 1_000,
  ) {
    this.schedule = schedule;
    this.decide = decide;
    this.waitMs = waitMs;
  }
  opened(kind: PopupKind): void {
    const waiting = this.waiting.shift();
    if (waiting) {
      waiting.cancel();
      this.decide(waiting.target, kind);
    } else if (this.kinds.length < 8) this.kinds.push(kind);
  }
  arrived(target: T): void {
    const kind = this.kinds.shift();
    if (kind || this.waiting.length >= 8) {
      this.decide(target, kind);
      return;
    }
    const entry = { target, cancel: () => {} };
    entry.cancel = this.schedule(() => {
      this.waiting = this.waiting.filter((candidate) => candidate !== entry);
      this.decide(target, undefined);
    }, this.waitMs);
    this.waiting.push(entry);
  }
  /** The opener went away: targets still waiting are handed to `drop`. */
  clear(drop: (target: T) => void): void {
    for (const entry of this.waiting.splice(0)) {
      entry.cancel();
      drop(entry.target);
    }
    this.kinds = [];
  }
}
