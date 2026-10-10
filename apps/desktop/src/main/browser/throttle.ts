/** What decides whether an embedded view may be background-throttled, and where it renders. */
export interface ViewActivity {
  /** Drawn in the Browser panel right now. */
  visible: boolean;
  /** The person's own input reaches the view (a `human` lease held here). */
  nativeInput: boolean;
  /** The daemon's lease gives the page to an agent, so commands are the agent's. */
  agentControl: boolean;
  /** A CDP screencast is running (someone is watching through the daemon). */
  screencasting: boolean;
  /** When the agent last sent the view a command, navigation, key press or resize. */
  lastDrivenAt: number;
}

/**
 * - `placed`: drawn in a renderer's Browser panel;
 * - `parked`: rendering, unseen, in the app's hidden parking window. Chromium produces no
 *   frames for a hidden view, so screenshots and `requestAnimationFrame` would stall while an
 *   agent drives a view nobody shows;
 * - `hidden`: not rendering; page timers and state live on.
 */
export type ViewPresence = "placed" | "parked" | "hidden";

export type ThrottleDecision = { presence: ViewPresence } & (
  | { throttle: true }
  | {
      throttle: false;
      /** Decide again after this long, unless something changes first. */
      recheckInMs?: number;
    }
);

/**
 * A view nobody sees and nobody drives runs its timers at background rate (Chromium's
 * background throttling) instead of at full speed, and stops rendering. Anything that could
 * depend on page timing keeps it at full speed: being on screen, the person's control, a
 * screencast, or an agent command within `idleMs`; an agent command also keeps an unseen view
 * rendering (parked) while the agent holds the lease. Neither ever closes the view or loses page
 * state, so the daemon's session is untouched (ADR 0055, ADR 0069).
 */
export function throttleDecision(
  activity: ViewActivity,
  now: number,
  idleMs: number,
): ThrottleDecision {
  if (activity.visible) return { presence: "placed", throttle: false };
  if (activity.screencasting) return { presence: "parked", throttle: false };
  const idleFor = now - activity.lastDrivenAt;
  if (idleFor < idleMs)
    return {
      // A person's own commands come from where they see the page; only agent work parks.
      presence: activity.agentControl ? "parked" : "hidden",
      throttle: false,
      recheckInMs: idleMs - idleFor,
    };
  if (activity.nativeInput || activity.screencasting)
    return { presence: "hidden", throttle: false };
  return { presence: "hidden", throttle: true };
}
