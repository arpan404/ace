/** What decides whether the app keeps running, and whether its tray icon is up. */
export interface LifetimeFacts {
  platform: NodeJS.Platform;
  /** The person's "keep running in the background" setting. */
  background: boolean;
  /** An app window is open. */
  window: boolean;
  /** Threads whose native browser pages the app hosts (in a window or parked). */
  browserPages: number;
  /** Agents working right now, as the daemon link last reported. */
  working: number;
}

export interface Lifetime {
  quit: boolean;
  tray: boolean;
}

/**
 * The app's lifetime once its last window closes. macOS apps stay open without windows, as
 * they always have. Elsewhere the app used to quit, and stop the daemon it started, which
 * killed working agents and the thread pages they browse; it now stays running, with its tray
 * icon as the way back in (and out), while any agent works or any thread has a native page.
 * With neither it quits as before, unless the person keeps ace in the background anyway.
 */
export function appLifetime(facts: LifetimeFacts): Lifetime {
  if (facts.window || facts.platform === "darwin" || facts.background)
    return { quit: false, tray: facts.background };
  const busy = facts.browserPages > 0 || facts.working > 0;
  return { quit: !busy, tray: busy };
}
