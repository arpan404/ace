import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import {
  CountsTimeline,
  FlightCounter,
  type LinkCounts,
  type LinkDirectionName,
} from "./link-flights.ts";
import { Bottleneck, type Arrival } from "./link-bottleneck.ts";
import { seededRandom, type LinkProfile } from "./link-profiles.ts";

/*
 * A local TCP proxy that puts one link between clients and a listener. It forwards bytes and
 * never parses them, so TLS and WebSocket traffic pass through untouched. Every connection
 * through one shaper shares that link: one Bottleneck per direction, which serves connections
 * in turn (link-bottleneck.ts). A new connection's first bytes wait out one round trip, the TCP
 * handshake.
 *
 * Backpressure runs end to end. Each connection holds at most `profile.queueBytes` per
 * direction (64 KiB in every profile, about one TCP receive window): bytes queued at the
 * bottleneck, crossing it, or arrived but not yet taken by the receiver. The read that crosses
 * the bound is kept, so the most held is the bound plus one socket read (up to 64 KiB on Node,
 * 512 KiB on Bun); those bytes are ahead in the same stream either way, so per-connection
 * delays are unchanged by where they wait. Past the bound the proxy stops reading from the sender, whose own buffers then fill and whose writes stall, as behind
 * a real slow link; it reads again once the connection holds half the bound. A receiver that
 * stops reading stops the proxy's writes to it (`write()` returning false, until `drain`), so
 * held bytes stay bounded and the sender stalls. Bytes count as delivered only once written
 * through to the receiver's socket. Each direction ends (half-close) only after its delayed
 * bytes are written, so a client that sends a request and half-closes still gets the answer.
 */

export interface LinkShaperOptions {
  target: { host: string; port: number };
  profile: LinkProfile;
  /** Where the proxy listens; port 0 picks a free one. */
  listen?: { host: string; port: number };
  /** Seeds the loss draws, so a run's stalls fall on the same segments. */
  seed?: number;
  now?: () => number;
  schedule?: (ms: number, run: () => void) => () => void;
}

export interface LinkShaper {
  readonly host: string;
  readonly port: number;
  /** `host:port`, for building URLs that go through the link. */
  readonly address: string;
  readonly profile: LinkProfile;
  /** Totals since the shaper started; diff two with `countsSince`. */
  counts(): LinkCounts;
  /** Totals as they stood at `at`, on the shaper's clock (`performance.now()` by default). */
  countsAt(at: number): LinkCounts;
  /** The most bytes one connection direction has held at once: the bound plus one read at most. */
  peakHeldBytes(): number;
  /** Drops every open connection, as the network going away does. */
  dropConnections(): void;
  close(): Promise<void>;
}

/** One direction of one connection: its sender, its receiver, and what it holds between. */
interface Leg {
  connection: number;
  from: Socket;
  to: Socket;
  /** Arrived or arriving bytes not yet written, in order. */
  pending: Arrival[];
  pendingBytes: number;
  timer: (() => void) | undefined;
  /** The receiver asked us to wait for `drain`. */
  blocked: boolean;
  paused: boolean;
  ended: boolean;
}

export async function startLinkShaper(options: LinkShaperOptions): Promise<LinkShaper> {
  const now = options.now ?? (() => performance.now());
  const schedule =
    options.schedule ??
    ((ms: number, run: () => void) => {
      const timer = setTimeout(run, Math.max(0, ms));
      return () => clearTimeout(timer);
    });
  const { profile } = options;
  const random = seededRandom(options.seed ?? 1);
  const flights = new FlightCounter();
  const timeline = new CountsTimeline();
  const recorded = () => timeline.record(now(), flights.snapshot());
  const sockets = new Set<Socket>();
  const bound = profile.queueBytes;
  let peakHeld = 0;
  let nextConnection = 0;

  /** One shared link per direction, its legs by connection, and its wake-up timer. */
  const direction = (name: LinkDirectionName, bitsPerSecond: number | null) => {
    const link = new Bottleneck({
      bitsPerSecond,
      delayMs: profile.rttMs / 2,
      loss: profile.loss,
      stallMs: profile.stallMs,
      random,
    });
    const legs = new Map<number, Leg>();
    let wake: (() => void) | undefined;
    let stalls = 0;
    const held = (leg: Leg) => link.queued(leg.connection) + leg.pendingBytes;
    const pump = () => {
      wake?.();
      wake = undefined;
      for (const arrival of link.pump(now())) {
        const leg = legs.get(arrival.flow);
        if (!leg) continue;
        leg.pending.push(arrival);
        leg.pendingBytes += arrival.bytes.length;
        arm(leg);
      }
      if (link.stalls !== stalls) {
        flights.stalled(link.stalls - stalls);
        recorded();
      }
      stalls = link.stalls;
      const next = link.wakeAt();
      if (next !== undefined) wake = schedule(next - now(), pump);
    };
    const arm = (leg: Leg) => {
      const head = leg.pending[0];
      if (!head || leg.timer || leg.blocked) return;
      leg.timer = schedule(head.at - now(), () => {
        leg.timer = undefined;
        deliver(leg);
      });
    };
    const deliver = (leg: Leg) => {
      const at = now();
      while (!leg.blocked && leg.pending[0] && leg.pending[0].at <= at) {
        const head = leg.pending.shift();
        if (!head || leg.to.destroyed) break;
        const length = head.bytes.length;
        // Counted once the receiver's socket has taken it, not when it was scheduled.
        const written = leg.to.write(head.bytes, (error) => {
          if (error) return;
          flights.arrived(leg.connection, name, length);
          recorded();
        });
        leg.pendingBytes -= length;
        if (!written) {
          leg.blocked = true;
          leg.to.once("drain", () => {
            leg.blocked = false;
            deliver(leg);
          });
        }
      }
      settle(leg);
      arm(leg);
    };
    /** Reads again once the leg has room, and ends the receiver once all is written. */
    const settle = (leg: Leg) => {
      if (leg.paused && held(leg) <= bound / 2 && !leg.blocked) {
        leg.paused = false;
        leg.from.resume();
      }
      if (leg.ended && held(leg) === 0 && !leg.to.destroyed && !leg.to.writableEnded) leg.to.end();
    };
    const attach = (connection: number, from: Socket, to: Socket, holdUntil?: number) => {
      const leg: Leg = {
        connection,
        from,
        to,
        pending: [],
        pendingBytes: 0,
        timer: undefined,
        blocked: false,
        paused: false,
        ended: false,
      };
      legs.set(connection, leg);
      link.open(connection, holdUntil);
      from.on("data", (chunk: Buffer) => {
        link.write(connection, now(), chunk);
        const holding = held(leg);
        if (holding > peakHeld) peakHeld = holding;
        if (!leg.paused && holding > bound) {
          leg.paused = true;
          from.pause();
        }
        pump();
      });
      // The sender is done writing: end the receiver once what it sent is written through.
      const ending = () => {
        leg.ended = true;
        settle(leg);
      };
      from.on("end", ending);
      from.on("close", ending);
      return () => {
        leg.timer?.();
        legs.delete(connection);
        link.close(connection);
      };
    };
    return { attach };
  };

  const up = direction("up", profile.upBitsPerSecond);
  const down = direction("down", profile.downBitsPerSecond);

  const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (client) => {
    const connection = ++nextConnection;
    flights.opened(connection);
    recorded();
    const upstream = connect({
      port: options.target.port,
      host: options.target.host,
      allowHalfOpen: true,
    });
    sockets.add(client);
    sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    // SYN out, SYN-ACK back: the client's first byte leaves one round trip after it connected.
    const stops = [
      up.attach(connection, client, upstream, now() + profile.rttMs),
      down.attach(connection, upstream, client),
    ];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const stop of stops) stop();
      flights.closed(connection);
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", close);
    upstream.on("error", close);
    // Released once both sides are gone; a reset on either side drops the other at once.
    let gone = 0;
    const release = () => {
      if (++gone === 2) close();
    };
    client.on("close", release);
    upstream.on("close", release);
    upstream.once("connect", () => client.resume());
  });
  const listen = options.listen ?? { host: "127.0.0.1", port: 0 };
  server.listen(listen.port, listen.host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Link shaper has no address");
  const host = listen.host;
  return {
    host,
    port: address.port,
    address: `${host}:${address.port}`,
    profile,
    counts: () => flights.snapshot(),
    countsAt: (at) => timeline.at(at),
    peakHeldBytes: () => peakHeld,
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
