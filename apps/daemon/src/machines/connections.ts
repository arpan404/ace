import { createHash } from "node:crypto";
import type { Agent } from "node:https";
import { pinnedKeepAliveAgent, type PinnedSessions } from "../client-access.ts";
import type { RemoteProfile } from "../cli/profiles.ts";

/** What a connection is opened for: where, the key it must present, and the token it carries. */
export type ConnectionProfile = Pick<RemoteProfile, "origin" | "fingerprint" | "token">;

/**
 * Which connections a call uses. `urgent` calls (a cancel, a stop, an answer to the person's
 * request) have connections of their own, which long tool calls can never fill.
 */
export type ConnectionLane = "shared" | "urgent";

/** An open connection's use by one request, given back once its answer has been read. */
export interface ConnectionLease {
  agent: Agent;
  /** Given back with the answer's headers, when an answer came. */
  release(answer?: AnswerHeaders): void;
}

/** What an answer says about the connection and the machine behind it. */
export interface AnswerHeaders {
  keepAlive: string | undefined;
}

export interface MachineConnectionsDeps {
  schedule(ms: number, run: () => void): () => void;
}

/** Idle connections close this long before the other machine says it would close them. */
const IDLE_MARGIN_MS = 2000;
/** The longest a connection is kept idle, whatever the other machine allows. */
const IDLE_CAP_MS = 45_000;
/** Kept this long when the other machine says nothing, as an older daemon's 5 s allows. */
const IDLE_DEFAULT_MS = 3000;
/**
 * Connections per machine per lane: tool calls and reads share six. Urgent calls open one more
 * connection rather than wait behind another urgent call, up to eight at once; two are kept
 * open when idle.
 */
const laneSockets: Record<ConnectionLane, number> = { shared: 6, urgent: 8 };

interface Lane {
  agent: Agent | undefined;
  inflight: number;
  cancelIdle: (() => void) | undefined;
}

interface Entry {
  lanes: Record<ConnectionLane, Lane>;
  sessions: PinnedSessions;
  idleMs: number;
}

/** How long an idle connection is kept, from the other machine's `Keep-Alive: timeout=N`. */
export function idleMs(keepAlive: string | undefined): number | undefined {
  const seconds = keepAlive?.match(/(?:^|[\s,])timeout=(\d+)/)?.[1];
  if (seconds === undefined) return undefined;
  return Math.max(0, Math.min(IDLE_CAP_MS, Number(seconds) * 1000 - IDLE_MARGIN_MS));
}

const lane = (): Lane => ({ agent: undefined, inflight: 0, cancelIdle: undefined });

/**
 * Pinned keep-alive agents per paired machine, so calls reuse an open, already pinned
 * connection instead of paying TCP and TLS each time, and a new connection resumes its TLS
 * session. Keyed by origin, public-key pin and device token together: re-pairing, a new pin or a
 * new token opens new agents, so an old socket is never reused across them. Connections close
 * once idle, before the other machine would close them, so a request rarely lands on a socket the
 * other side just dropped. Each machine has two lanes, so urgent calls never wait behind long
 * ones.
 */
export class MachineConnections {
  private deps: MachineConnectionsDeps;
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(deps: MachineConnectionsDeps) {
    this.deps = deps;
  }
  lease(profile: ConnectionProfile, use: ConnectionLane = "shared"): ConnectionLease {
    const key = connectionKey(profile);
    let entry = this.entries.get(key);
    if (!entry) {
      let session: Buffer | undefined;
      entry = {
        lanes: { shared: lane(), urgent: lane() },
        sessions: { get: () => session, set: (next) => void (session = next) },
        idleMs: IDLE_DEFAULT_MS,
      };
      if (!this.closed) this.entries.set(key, entry);
    }
    const held = entry;
    const at = held.lanes[use];
    at.cancelIdle?.();
    at.cancelIdle = undefined;
    const agent =
      at.agent ?? pinnedKeepAliveAgent(profile.fingerprint, held.sessions, laneSockets[use]);
    at.agent = agent;
    at.inflight++;
    let released = false;
    return {
      agent,
      release: (answer) => {
        if (released) return;
        released = true;
        at.inflight--;
        if (answer) held.idleMs = idleMs(answer.keepAlive) ?? held.idleMs;
        if (at.inflight > 0) return;
        if (this.closed || this.entries.get(key) !== held) {
          agent.destroy();
          if (at.agent === agent) at.agent = undefined;
          return;
        }
        at.cancelIdle?.();
        at.cancelIdle = this.deps.schedule(held.idleMs, () => {
          at.cancelIdle = undefined;
          if (at.inflight > 0 || at.agent !== agent) return;
          at.agent = undefined;
          agent.destroy();
        });
      },
    };
  }
  /** Drops connections to machines no longer paired as they were (unpaired, new pin or token). */
  retain(profiles: readonly ConnectionProfile[]): void {
    const keep = new Set(profiles.map(connectionKey));
    for (const [key, entry] of this.entries)
      if (!keep.has(key)) {
        this.entries.delete(key);
        drop(entry);
      }
  }
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) drop(entry);
    this.entries.clear();
  }
}

/** Idle sockets close now; one still answering a request closes when it is given back. */
function drop(entry: Entry) {
  for (const at of Object.values(entry.lanes)) {
    at.cancelIdle?.();
    at.cancelIdle = undefined;
    if (at.inflight === 0) {
      at.agent?.destroy();
      at.agent = undefined;
    }
  }
}

function connectionKey(profile: ConnectionProfile): string {
  return createHash("sha256")
    .update(`${profile.origin}\0${profile.fingerprint}\0${profile.token}`)
    .digest("hex");
}
