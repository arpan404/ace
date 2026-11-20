import type { Notification } from "@ace/protocol";

/*
 * How a Spade alert shows in this window (ADR 0194). Spade already decided it reaches the
 * person now; the window decides how: nothing for the conversation on screen, a toast while
 * the window is in front, a system notification while it isn't (a browser tab that allowed
 * them), and one line for a burst. Pure: the notifier passes what it sees.
 */

/** More than this many alerts within `burstMs` show as one. */
export const burstLimit = 3;
export const burstMs = 10_000;

export type SpadeShow =
  | { kind: "skip"; why: "off" | "open" | "unreadable" }
  | { kind: "toast" | "system"; title: string; body: string; tag: string; agent: string; request?: string }
  | { kind: "burst"; title: string; body: string; tag: string; count: number };

export interface SpadeSeen {
  /** Spade's notifications are on in this window. */
  on: boolean;
  /** The window is in front and shown. */
  visible: boolean;
  /** The Spade bot whose conversation is on screen, when one is. */
  openAgent: string | undefined;
  /** When the alerts shown in the last moments arrived, this one's included. */
  recent: readonly number[];
}

export function spadeShow(notification: Notification, seen: SpadeSeen): SpadeShow {
  const target = notification.spade;
  if (notification.status !== "spade" || !target) return { kind: "skip", why: "unreadable" };
  if (!seen.on) return { kind: "skip", why: "off" };
  // The person is looking at this conversation: it shows there already.
  if (seen.visible && seen.openAgent === target.agent) return { kind: "skip", why: "open" };
  if (seen.recent.length > burstLimit)
    return {
      kind: "burst",
      title: "Spade",
      body: `${seen.recent.length} updates from your bots`,
      tag: "spade:burst",
      count: seen.recent.length,
    };
  return {
    kind: seen.visible ? "toast" : "system",
    title: notification.title,
    body: notification.message ?? "",
    // One per bot: a newer alert from it takes the older one's place.
    tag: `spade:${target.agent}`,
    agent: target.agent,
    ...(target.request ? { request: target.request } : {}),
  };
}

/** The arrivals still inside the burst window, with `now`'s. */
export function withinBurst(recent: readonly number[], now: number): number[] {
  return [...recent.filter((at) => now - at < burstMs), now];
}

/** The bot whose conversation a path shows, `/spade/<id>`; none for any other page. */
export function openSpadeAgent(pathname: string, search: Record<string, unknown>): string | undefined {
  const match = /^\/spade\/([^/]+)\/?$/.exec(pathname);
  // A bot on another machine (`on`) is another conversation than this daemon's.
  if (!match?.[1] || match[1] === "new" || search.on !== undefined) return undefined;
  return decodeURIComponent(match[1]);
}
