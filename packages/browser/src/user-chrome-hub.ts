import type { UserBrowserConnection, UserBrowserIdentity } from "@ace/protocol";
import type { NavigationClock } from "./navigation.ts";
import { UserChromeLink, type UserChromeTransport } from "./user-chrome-link.ts";

/** Browser profiles connected at once; each runs its own extension and host. */
export const userChromeLinkLimit = 8;

/**
 * Every browser profile connected through "Use my Chrome" (ADR 0084). The same profile
 * reconnecting (an extension update, a daemon restart) replaces its previous link.
 */
export class UserChromeHub {
  private links = new Map<string, UserChromeLink>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  private now: () => number;
  private clock: NavigationClock;
  private id: () => string;
  constructor(options: { now: () => number; clock: NavigationClock; id?: () => string }) {
    this.now = options.now;
    this.clock = options.clock;
    this.id = options.id ?? (() => `user-${++this.sequence}`);
  }
  register(browser: UserBrowserIdentity, transport: UserChromeTransport): UserChromeLink {
    for (const link of this.links.values())
      if (link.browser.profileId === browser.profileId)
        link.close("This browser profile connected again");
    if (this.links.size >= userChromeLinkLimit) throw new Error("Too many connected browsers");
    const link = new UserChromeLink({
      connectionId: this.id(),
      browser,
      connectedAt: this.now(),
      transport,
      clock: this.clock,
    });
    this.links.set(link.connectionId, link);
    link.onTabsChanged(() => this.changed());
    link.onClosed(() => {
      if (this.links.get(link.connectionId) === link) this.links.delete(link.connectionId);
      this.changed();
    });
    this.changed();
    return link;
  }
  get(connectionId: string): UserChromeLink | undefined {
    return this.links.get(connectionId);
  }
  /** The browser agents use when a call names none: the most recently connected one. */
  preferred(): UserChromeLink | undefined {
    return [...this.links.values()].toSorted((a, b) => b.connectedAt - a.connectedAt)[0];
  }
  connections(): UserBrowserConnection[] {
    return [...this.links.values()].map((link) => ({
      connectionId: link.connectionId,
      browser: link.browser,
      connectedAt: link.connectedAt,
      tabs: link.tabs(),
    }));
  }
  /**
   * Settings' Stop: every connected browser detaches every tab and forgets every share. A browser
   * that does not answer within `waitMs` is not waited for; revoking closes its link anyway.
   */
  async stopAll(waitMs = 3_000): Promise<void> {
    const deadline = new AbortController();
    const cancel = this.clock.set(waitMs, () => deadline.abort(new Error("Browser did not stop")));
    try {
      await Promise.allSettled(
        [...this.links.values()].map((link) => link.command({ op: "stop" }, deadline.signal)),
      );
    } finally {
      cancel();
    }
  }
  /** Revocation or shutdown: drop every link. */
  closeAll(reason: string): void {
    for (const link of this.links.values()) link.close(reason);
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
