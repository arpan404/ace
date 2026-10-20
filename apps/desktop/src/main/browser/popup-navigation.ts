/** Chromium's transient user activation lasts five seconds after a click or key press. */
const activationMs = 5_000;

/** Remembers the last input the page accepted: a person's own, or one an agent sent. */
export class UserActivation {
  private readonly now: () => number;
  private last = Number.NEGATIVE_INFINITY;
  private lastBy: "person" | "agent" = "agent";
  constructor(now: () => number) {
    this.now = now;
  }
  note(by: "person" | "agent"): void {
    this.last = this.now();
    this.lastBy = by;
  }
  /** Any recent input: a page may follow a link it opens in a new tab. */
  active(): boolean {
    return this.now() - this.last <= activationMs;
  }
  /**
   * The person's own click or key press activated the page, and no agent input came since.
   * Only then may the page write the system clipboard: an agent's click activates the page
   * too, and must never let it replace what the person copied.
   */
  byPerson(): boolean {
    return this.active() && this.lastBy === "person";
  }
}

/**
 * The embedded browser shows one tab, so a page's request for a new tab or window can only
 * replace the current page. Pages (ad scripts above all) open blank, same-address and
 * unprompted windows freely; following those would reload or hijack the page. Only a
 * request that follows real input and leads to another web address is followed.
 */
export function popupNavigation(request: {
  url: string;
  current: string;
  activated: boolean;
}): string | undefined {
  if (!request.activated) return undefined;
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return undefined;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  if (target.href === request.current) return undefined;
  return target.href;
}
