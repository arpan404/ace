/** What decides whether an embedded view may be background-throttled. */
export interface ViewActivity {
  /** Drawn in the Browser panel right now. */
  visible: boolean;
  /** The person's own input reaches the view (a `human` lease held here). */
  nativeInput: boolean;
  /** A CDP screencast is running (someone is watching through the daemon). */
  screencasting: boolean;
  /** When the agent last sent the view a command, navigation, key press or resize. */
  lastDrivenAt: number;
}

export type ThrottleDecision =
  | { throttle: true }
  | {
      throttle: false;
      /** Decide again after this long, unless something changes first. */
      recheckInMs?: number;
    };

/**
 * A view nobody sees and nobody drives runs its timers at background rate (Chromium's
 * background throttling) instead of at full speed. Anything that could depend on page timing
 * keeps it at full speed: being on screen, the person's control, a screencast, or an agent
 * command within `idleMs`. Throttling only slows a page's timers; it never closes the view
 * or loses page state, so the daemon's session is untouched (ADR 0055).
 */
export function throttleDecision(
  activity: ViewActivity,
  now: number,
  idleMs: number,
): ThrottleDecision {
  if (activity.visible || activity.nativeInput || activity.screencasting)
    return { throttle: false };
  const idleFor = now - activity.lastDrivenAt;
  if (idleFor < idleMs) return { throttle: false, recheckInMs: idleMs - idleFor };
  return { throttle: true };
}
