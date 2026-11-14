import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { FlightCounter, type LinkCounts, type LinkDirectionName } from "./link-flights.ts";
import { LinkPipe } from "./link-pipe.ts";
import { seededRandom, type LinkProfile } from "./link-profiles.ts";

/*
 * A local TCP proxy that puts a link profile between a client and a listener. It forwards bytes
 * and never parses them, so TLS and WebSocket traffic pass through untouched, and times their
 * arrival with LinkPipe. A new connection's first bytes wait out one round trip, the TCP
 * handshake. A direction whose bottleneck queue passes the profile's bound stops reading from
 * its sender until it drains, so a sender's own buffers fill, as they would behind a slow link.
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
  /** Drops every open connection, as the network going away does. */
  dropConnections(): void;
  close(): Promise<void>;
}

interface Delivery {
  bytes: Buffer;
  at: number;
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
  const sockets = new Set<Socket>();
  let nextConnection = 0;

  /** Forwards one direction of one connection through a pipe. */
  const direction = (
    connection: number,
    name: LinkDirectionName,
    from: Socket,
    to: Socket,
    pipe: LinkPipe,
  ) => {
    const pending: Delivery[] = [];
    let cancel: (() => void) | undefined;
    let ended = false;
    let paused = false;
    let resume: (() => void) | undefined;
    let stalls = 0;
    const finish = () => {
      if (ended && pending.length === 0 && !to.destroyed) to.end();
    };
    const deliver = () => {
      cancel = undefined;
      const at = now();
      while (pending[0] && pending[0].at <= at) {
        const head = pending.shift();
        if (!head) break;
        flights.arrived(connection, name, head.bytes.length);
        if (!to.destroyed) to.write(head.bytes);
      }
      arm();
      finish();
    };
    const arm = () => {
      const head = pending[0];
      if (!head || cancel) return;
      cancel = schedule(head.at - now(), deliver);
    };
    from.on("data", (chunk: Buffer) => {
      const at = now();
      for (const arrival of pipe.send(at, chunk.length))
        pending.push({ bytes: chunk.subarray(arrival.start, arrival.end), at: arrival.at });
      flights.stalled(pipe.stalls - stalls);
      stalls = pipe.stalls;
      arm();
      if (!paused && pipe.queued(at) > profile.queueBytes) {
        paused = true;
        from.pause();
        resume = schedule(pipe.drainsTo(profile.queueBytes / 2) - at, () => {
          paused = false;
          resume = undefined;
          from.resume();
        });
      }
    });
    from.on("end", () => {
      ended = true;
      finish();
    });
    return () => {
      cancel?.();
      resume?.();
      pending.length = 0;
    };
  };

  const server = createServer({ pauseOnConnect: true }, (client) => {
    const connection = ++nextConnection;
    flights.opened(connection);
    const upstream = connect(options.target.port, options.target.host);
    sockets.add(client);
    sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const pipes = {
      up: new LinkPipe({
        bitsPerSecond: profile.upBitsPerSecond,
        delayMs: profile.rttMs / 2,
        loss: profile.loss,
        stallMs: profile.stallMs,
        random,
      }),
      down: new LinkPipe({
        bitsPerSecond: profile.downBitsPerSecond,
        delayMs: profile.rttMs / 2,
        loss: profile.loss,
        stallMs: profile.stallMs,
        random,
      }),
    };
    // SYN out, SYN-ACK back: the client's first byte leaves one round trip after it connected.
    pipes.up.holdUntil(now() + profile.rttMs);
    const stops = [
      direction(connection, "up", client, upstream, pipes.up),
      direction(connection, "down", upstream, client, pipes.down),
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
    client.on("close", close);
    upstream.on("close", close);
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
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
