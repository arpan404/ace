import type { MediaClock } from "./supervisor-host.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/*
 * The main session's link, told to ace-media (ADR 0149, K3): for every main session that has a
 * media connection, its smoothed round trip and the bytes queued to it, every 500 ms. Video
 * reads it to yield the link as soon as the conversation slows. `SessionLinks` is pure; the
 * pump at the bottom is its timer.
 */

export const sessionLinkEveryMs = 500;
/** Each round trip moves the smoothed one this far toward it (RFC 6298's alpha). */
const rttGain = 1 / 8;
const maxRttMs = 0xffffffff;

type SessionLink = Extract<ToMedia, { type: "session.link" }>;
type Session = { rttMs: number | undefined; backlogBytes: number; connections: number };

export class SessionLinks {
  readonly #sessions = new Map<string, Session>();
  /** Each open media connection's main session. */
  readonly #connections = new Map<string, string>();

  /** ace-media's word on its connections: one opened for a session, or one closed. */
  received(message: FromMedia): void {
    if (message.type === "connection.open") {
      if (this.#connections.has(message.connection)) return;
      this.#connections.set(message.connection, message.owner.session);
      this.#session(message.owner.session).connections++;
    } else if (message.type === "connection.closed") {
      const session = this.#connections.get(message.connection);
      if (session === undefined) return;
      this.#connections.delete(message.connection);
      const entry = this.#sessions.get(session);
      if (entry) entry.connections--;
    }
  }

  /** One round trip measured on a main session, with the bytes queued to it now. */
  sample(session: string, rttMs: number, backlogBytes: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    const entry = this.#session(session);
    entry.rttMs = entry.rttMs === undefined ? rttMs : entry.rttMs + (rttMs - entry.rttMs) * rttGain;
    entry.backlogBytes = Number.isFinite(backlogBytes) ? Math.max(0, backlogBytes) : 0;
  }

  /** The main session ended: nothing more is said about it. */
  ended(session: string): void {
    this.#sessions.delete(session);
    for (const [connection, owner] of this.#connections)
      if (owner === session) this.#connections.delete(connection);
  }

  /** ace-media restarted: its connections went with it. */
  restarted(): void {
    this.#connections.clear();
    for (const entry of this.#sessions.values()) entry.connections = 0;
  }

  /** What to send now: one per main session with a media connection and a round trip. */
  signals(): SessionLink[] {
    const out: SessionLink[] = [];
    for (const [session, entry] of this.#sessions) {
      if (entry.connections <= 0 || entry.rttMs === undefined) continue;
      out.push({
        type: "session.link",
        session,
        rttMs: Math.min(maxRttMs, Math.round(entry.rttMs)),
        backlogBytes: Math.min(Number.MAX_SAFE_INTEGER, Math.round(entry.backlogBytes)),
      });
    }
    return out;
  }

  #session(session: string): Session {
    let entry = this.#sessions.get(session);
    if (!entry) {
      entry = { rttMs: undefined, backlogBytes: 0, connections: 0 };
      this.#sessions.set(session, entry);
    }
    return entry;
  }
}

/** Sends `links.signals()` every 500 ms until the returned stop is called. */
export function pumpSessionLinks(
  links: SessionLinks,
  clock: MediaClock,
  send: (message: SessionLink) => void,
): () => void {
  let stopped = false;
  let cancel = clock.setTimeout(tick, sessionLinkEveryMs);
  function tick(): void {
    if (stopped) return;
    for (const message of links.signals()) send(message);
    cancel = clock.setTimeout(tick, sessionLinkEveryMs);
  }
  return () => {
    stopped = true;
    cancel();
  };
}
