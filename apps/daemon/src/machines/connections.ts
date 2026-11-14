import { createHash } from "node:crypto";
import type { Agent } from "node:https";
import { pinnedKeepAliveAgent } from "../client-access.ts";
import type { RemoteProfile } from "../cli/profiles.ts";

/** What a connection is opened for: where, the key it must present, and the token it carries. */
export type ConnectionProfile = Pick<RemoteProfile, "origin" | "fingerprint" | "token">;

/** An open connection's use by one request, given back once its answer has been read. */
export interface ConnectionLease {
  agent: Agent;
  /** `keepAlive` is the answer's `Keep-Alive` header, when one came. */
  release(keepAlive?: string): void;
}

export interface MachineConnectionsDeps {
  schedule(ms: number, run: () => void): () => void;
  /** Opens the agent for one profile; tests pass their own roots or clock. */
  open?(profile: ConnectionProfile, sessions: Entry["sessions"]): Agent;
}

/** Idle connections close this long before the other machine says it would close them. */
const IDLE_MARGIN_MS = 2000;
/** The longest a connection is kept idle, whatever the other machine allows. */
const IDLE_CAP_MS = 45_000;
/** Kept this long when the other machine says nothing, as an older daemon's 5 s allows. */
const IDLE_DEFAULT_MS = 3000;

interface Entry {
  agent: Agent | undefined;
  sessions: { get(): Buffer | undefined; set(session: Buffer): void };
  inflight: number;
  idleMs: number;
  cancelIdle: (() => void) | undefined;
}

/** How long an idle connection is kept, from the other machine's `Keep-Alive: timeout=N`. */
export function idleMs(keepAlive: string | undefined): number | undefined {
  const seconds = keepAlive?.match(/(?:^|[\s,])timeout=(\d+)/)?.[1];
  if (seconds === undefined) return undefined;
  return Math.max(0, Math.min(IDLE_CAP_MS, Number(seconds) * 1000 - IDLE_MARGIN_MS));
}

/**
 * One pinned keep-alive agent per paired machine, so calls reuse an open, already pinned
 * connection instead of paying TCP and TLS each time, and a new connection resumes its TLS
 * session. Keyed by origin, public-key pin and device token together: re-pairing, a new pin or a
 * new token opens a new agent, so an old socket is never reused across them. Connections close
 * once idle, before the other machine would close them, so a request never lands on a socket the
 * other side just dropped.
 */
export class MachineConnections {
  private deps: MachineConnectionsDeps;
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(deps: MachineConnectionsDeps) {
    this.deps = deps;
  }
  lease(profile: ConnectionProfile): ConnectionLease {
    const key = connectionKey(profile);
    let entry = this.entries.get(key);
    if (!entry) {
      let session: Buffer | undefined;
      entry = {
        agent: undefined,
        sessions: { get: () => session, set: (next) => void (session = next) },
        inflight: 0,
        idleMs: IDLE_DEFAULT_MS,
        cancelIdle: undefined,
      };
      if (!this.closed) this.entries.set(key, entry);
    }
    const held = entry;
    held.cancelIdle?.();
    held.cancelIdle = undefined;
    const agent =
      held.agent ??
      (this.deps.open ?? ((open, sessions) => pinnedKeepAliveAgent(open.fingerprint, sessions)))(
        profile,
        held.sessions,
      );
    held.agent = agent;
    held.inflight++;
    let released = false;
    return {
      agent,
      release: (keepAlive) => {
        if (released) return;
        released = true;
        held.inflight--;
        held.idleMs = idleMs(keepAlive) ?? held.idleMs;
        if (held.inflight > 0) return;
        if (this.closed || this.entries.get(key) !== held) {
          agent.destroy();
          if (held.agent === agent) held.agent = undefined;
          return;
        }
        held.cancelIdle?.();
        held.cancelIdle = this.deps.schedule(held.idleMs, () => {
          held.cancelIdle = undefined;
          if (held.inflight > 0 || held.agent !== agent) return;
          held.agent = undefined;
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
        this.drop(entry);
      }
  }
  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) this.drop(entry);
    this.entries.clear();
  }
  /** Idle sockets close now; one still answering a request closes when it is given back. */
  private drop(entry: Entry) {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    if (entry.inflight === 0) {
      entry.agent?.destroy();
      entry.agent = undefined;
    }
  }
}

function connectionKey(profile: ConnectionProfile): string {
  return createHash("sha256")
    .update(`${profile.origin}\0${profile.fingerprint}\0${profile.token}`)
    .digest("hex");
}
