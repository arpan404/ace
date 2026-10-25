import type { WorkSummary } from "../link/thread-watch.ts";

/** What decides whether the app keeps running, and whether its tray icon is up. */
export interface LifetimeFacts {
  platform: NodeJS.Platform;
  /** The person's "keep running in the background" setting. */
  background: boolean;
  /** An app window is open. */
  window: boolean;
  /** Threads whose native browser pages the app hosts (in a window or parked). */
  browserPages: number;
  /** Threads with work in flight or waiting on the person, as the daemon link last reported. */
  work: WorkSummary;
}

export interface Lifetime {
  quit: boolean;
  tray: boolean;
}

/**
 * The app's lifetime once its last window closes. macOS apps stay open without windows, as
 * they always have. Elsewhere the app used to quit, and stop the daemon it started, which
 * killed working agents and the thread pages they browse; it now stays running, with its tray
 * icon as the way back in (and out), while any thread is unfinished or has a native page. A
 * thread waiting on the person counts: quitting would stop it and drop the approval or
 * question it waits on. So does a thread paused at a usage limit or with a silent agent: neither
 * is done, and stopping the daemon would end it. With none of these it quits as before, unless the person keeps ace
 * in the background anyway.
 */
export function appLifetime(facts: LifetimeFacts): Lifetime {
  if (facts.window || facts.platform === "darwin" || facts.background)
    return { quit: false, tray: facts.background };
  const { needsYou, working, held } = facts.work;
  const busy = facts.browserPages > 0 || working > 0 || needsYou > 0 || held > 0;
  return { quit: !busy, tray: busy };
}
