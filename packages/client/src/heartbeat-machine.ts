/**
 * Liveness of one ready socket, as a pure state machine (ADR 0150). `Heartbeat` is its shell:
 * it sends the pings this asks for, feeds back what happened, and runs one timer for `nextAt`.
 *
 * Two loops share it. The regular beat pings every `intervalMs`, and an interval after a ping
 * in which nothing at all arrived means the socket is dead (any frame is proof of life: a pong
 * queued behind a busy stream is late while the socket is plainly alive). A wake (the app came
 * back, or the network changed) probes instead, and a probe is answered only by the pong for a
 * ping sent at or after that wake: proof from before the wake proves nothing about the socket
 * now.
 *
 * Wakes coalesce forwards. A wake with no ping sent in the last `joinMs` pings now. A wake
 * inside that window sends nothing yet and owes one ping, sent when the window ends, whose
 * probe covers every wake since the last ping. So at most one ping goes out per `joinMs`, and
 * every wake is covered by a ping at most `joinMs` after it, with that wake's deadline counted
 * from the ping. An answered probe is gone at once; each probe keeps its own deadline, and
 * nothing moves an earlier one. A ping the socket refuses still leaves its probe's deadline in
 * place. Guarantee: a socket dead at a wake is reported dead within `joinMs` plus that wake's
 * deadline of the wake.
 */

export interface HeartbeatConfig {
  /** The regular beat's interval. */
  intervalMs: number;
  /** A wake this soon after the last ping waits for the window's end to ping. */
  joinMs: number;
}

interface Probe {
  /** The ping it waits for; undefined when that ping was refused. */
  seq: number | undefined;
  sentAt: number;
  deadline: number;
}

export interface HeartbeatState {
  running: boolean;
  /** Another loop pings this socket (the path manager's): no regular beat. */
  quiet: boolean;
  /** The regular beat, while no probe is waiting: when it next fires, and whether its last
   * ping has heard nothing since. */
  beat: { dueAt: number; awaiting: boolean } | undefined;
  probes: Probe[];
  /** A ping owed to wakes inside the window: when it goes, and the shortest deadline asked. */
  owed: { at: number; withinMs: number } | undefined;
  lastPingAt: number | undefined;
  /** When each ping still waiting for its pong was sent. */
  sent: Map<number, number>;
  nextSeq: number;
}

export type HeartbeatInput =
  | { type: "start"; now: number }
  | { type: "stop" }
  | { type: "quiet"; on: boolean; now: number }
  | { type: "wake"; now: number; withinMs: number }
  | { type: "refused"; seq: number; now: number }
  | { type: "pong"; seq: number; now: number }
  | { type: "frame" }
  | { type: "timer"; now: number };

export type HeartbeatEffect = { type: "ping"; seq: number } | { type: "missed" };

export function initialHeartbeat(): HeartbeatState {
  return {
    running: false,
    quiet: false,
    beat: undefined,
    probes: [],
    owed: undefined,
    lastPingAt: undefined,
    sent: new Map(),
    nextSeq: 0,
  };
}

/** When the shell's timer must next fire, if anything waits on one. */
export function nextAt(state: HeartbeatState): number | undefined {
  if (!state.running) return undefined;
  const times = [
    ...state.probes.map((probe) => probe.deadline),
    ...(state.owed ? [state.owed.at] : []),
    ...(state.beat ? [state.beat.dueAt] : []),
  ];
  return times.length ? Math.min(...times) : undefined;
}

/** Feed one input; returns the next state and what the shell must do, in order. */
export function stepHeartbeat(
  state: HeartbeatState,
  input: HeartbeatInput,
  config: HeartbeatConfig,
): { state: HeartbeatState; effects: HeartbeatEffect[] } {
  const next: HeartbeatState = {
    ...state,
    probes: [...state.probes],
    sent: new Map(state.sent),
  };
  const effects: HeartbeatEffect[] = [];
  const ping = (now: number) => {
    const seq = next.nextSeq++;
    next.sent.set(seq, now);
    next.lastPingAt = now;
    effects.push({ type: "ping", seq });
    return seq;
  };
  const probe = (now: number, withinMs: number) => {
    const seq = ping(now);
    next.probes.push({ seq, sentAt: now, deadline: now + withinMs });
  };
  /** Nothing waits on a probe any more: the regular beat takes over again. */
  const resume = (now: number) => {
    if (next.running && !next.quiet && !next.probes.length && !next.owed && !next.beat)
      next.beat = { dueAt: now + config.intervalMs, awaiting: false };
  };
  const dead = () => {
    effects.push({ type: "missed" });
    return { state: initialStopped(next.quiet), effects };
  };
  switch (input.type) {
    case "start":
      return {
        state: {
          ...initialHeartbeat(),
          quiet: state.quiet,
          running: true,
          nextSeq: state.nextSeq,
          beat: state.quiet ? undefined : { dueAt: input.now + config.intervalMs, awaiting: false },
        },
        effects,
      };
    case "stop":
      return { state: initialStopped(state.quiet), effects };
    case "quiet":
      next.quiet = input.on;
      if (input.on) next.beat = undefined;
      else resume(input.now);
      return { state: next, effects };
    case "frame":
      if (next.beat) next.beat = { ...next.beat, awaiting: false };
      return { state: next, effects };
    case "wake": {
      if (!next.running) return { state: next, effects };
      // The regular beat waits while any wake does.
      next.beat = undefined;
      const last = next.lastPingAt;
      if (last === undefined || input.now - last >= config.joinMs) {
        // This ping also covers the wakes that were owed one: it is sent no later than theirs.
        const withinMs = Math.min(next.owed?.withinMs ?? input.withinMs, input.withinMs);
        next.owed = undefined;
        probe(input.now, withinMs);
        return { state: next, effects };
      }
      next.owed = {
        at: last + config.joinMs,
        withinMs: Math.min(next.owed?.withinMs ?? input.withinMs, input.withinMs),
      };
      return { state: next, effects };
    }
    case "refused": {
      next.sent.delete(input.seq);
      // The probe keeps its deadline: a socket that takes no ping is dropped at it, unless a
      // later ping gets through and is answered first.
      next.probes = next.probes.map((each) =>
        each.seq === input.seq ? { ...each, seq: undefined } : each,
      );
      return { state: next, effects };
    }
    case "pong": {
      const sentAt = next.sent.get(input.seq);
      if (sentAt === undefined) return { state: next, effects };
      // Pongs come in order: this one answers its ping and every earlier one, and proves the
      // socket alive after `sentAt`, which covers a refused probe made no later.
      for (const seq of next.sent.keys()) if (seq <= input.seq) next.sent.delete(seq);
      next.probes = next.probes.filter((each) =>
        each.seq === undefined ? each.sentAt > sentAt : each.seq > input.seq,
      );
      resume(input.now);
      return { state: next, effects };
    }
    case "timer": {
      if (!next.running) return { state: next, effects };
      const now = input.now;
      if (next.probes.some((each) => each.deadline <= now)) return dead();
      if (next.owed && now >= next.owed.at) {
        const { withinMs } = next.owed;
        next.owed = undefined;
        probe(now, withinMs);
      }
      if (next.beat && now >= next.beat.dueAt) {
        if (next.beat.awaiting) return dead();
        ping(now);
        next.beat = { dueAt: now + config.intervalMs, awaiting: true };
      }
      return { state: next, effects };
    }
  }
}

function initialStopped(quiet: boolean): HeartbeatState {
  return { ...initialHeartbeat(), quiet };
}
