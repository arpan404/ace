import { createMux, type PreviewChannel } from "@ace/preview/mux";
import { PreviewPort } from "@ace/protocol/preview";
import type { TunnelRefusalCode } from "@ace/protocol";
import {
  authenticatedChannel,
  type AuthenticatedChannelOptions,
  type ChannelEvents,
} from "./device-transport.ts";
import { ClientError } from "./errors.ts";
import { tunnelStream, type TunnelStream } from "./tunnel-stream.ts";
export type { TunnelStream } from "./tunnel-stream.ts";

/*
 * A device's tunnel to its machine's loopback (ADR 0194): TCP streams to the machine's
 * `127.0.0.1` or `::1` on a port, carried on a connection of their own beside the machine
 * connection, on whichever path that connection is on. Portable: no Node API; the connection on
 * each path is injected (`tunnelChannel`, or the native bridge's equivalent).
 */

/** The tunnel to one connected machine. */
export interface MachineTunnel {
  /**
   * TCP stream to the machine's loopback port. Rejects with ClientError code: tunnel_off |
   * tunnel_forbidden | tunnel_port_refused | tunnel_limit | offline. A port with nothing
   * listening resets the stream (the browser sees a refused connection): the promise rejects
   * with `tunnel_reset`.
   */
  open(port: number): Promise<TunnelStream>;
  /** Loopback TCP ports the machine listens on, minus ace's own; updated change-only. */
  ports: { get(): readonly number[]; subscribe(changed: () => void): () => void };
  close(): void;
}

/** One tunnel connection, unopened: an `AuthenticatedChannel` with `channel: "tunnel"`. */
export interface TunnelLink {
  open(events: ChannelEvents): void;
  sendBinary(bytes: Uint8Array): Promise<void>;
  close(): void;
}

/** The path the machine connection is on, as the tunnel opens its own connection there. */
export interface TunnelPath {
  /** The path's identity (`PlannedPath.key`): a different key is a path switch. */
  readonly key: string;
  /** A new tunnel connection on this path, with this path's target and credential. */
  link(): TunnelLink;
}

export interface MachineTunnelOptions {
  /**
   * The machine connection's path: undefined while it is offline. A change of key moves new
   * streams to the new path; streams open on the old one finish there.
   */
  path: { get(): TunnelPath | undefined; subscribe(changed: () => void): () => void };
  /** Runs `run` after `delayMs`; the result cancels it. */
  schedule(run: () => void, delayMs: number): () => void;
  /** How long an old path's streams may take to finish after a switch; 15 s unless given. */
  drainMs?: number;
  /** Where the engine lacks a global `ReadableStream` (a bare JavaScriptCore), supply one. */
  ReadableStream?: typeof ReadableStream;
}

/** Waits before connecting again after a drop, by attempt; the last repeats. */
export const tunnelRetryMs = [250, 1_000, 2_000, 5_000, 10_000] as const;
/** After the machine refused the whole tunnel (off, or no authority), ask again this late. */
export const tunnelRefusedRetryMs = 30_000;
/** How long an old path's open streams may run after a switch before they are reset. */
export const tunnelDrainMs = 15_000;
/** Streams one tunnel connection may carry; the machine applies its own, lower, limits. */
const maxStreams = 512;

/** A tunnel connection over the TCP-to-machine `link` of one path. */
interface Connection {
  readonly key: string;
  readonly link: TunnelLink;
  mux: ReturnType<typeof createMux> | undefined;
  /** Waiters for the welcome; rejected if the connection ends first. */
  waiting: { resolve(): void; reject(error: ClientError): void }[];
  /** A refusal of the whole tunnel, from the machine. */
  refusal: TunnelRefusalCode | undefined;
  /** Per-stream refusals, read when that stream's RESET comes. */
  refusals: Map<number, TunnelRefusalCode>;
  streams: number;
  draining: boolean;
  ended: boolean;
  frame: ((frame: Uint8Array) => void) | undefined;
  lost: (() => void) | undefined;
  stopDrain: (() => void) | undefined;
}

/** A tunnel connection on `options`' path: `authenticatedChannel` with `channel: "tunnel"`. */
export function tunnelChannel(options: AuthenticatedChannelOptions): TunnelLink {
  return authenticatedChannel(options, "tunnel");
}

/** Opens the tunnel to one connected machine; it connects at once, so `ports` fills. */
export function openMachineTunnel(options: MachineTunnelOptions): MachineTunnel {
  const Readable = options.ReadableStream ?? globalThis.ReadableStream;
  if (typeof Readable !== "function") throw new Error("The tunnel needs a ReadableStream");
  const drainMs = options.drainMs ?? tunnelDrainMs;
  let current: Connection | undefined;
  const draining = new Set<Connection>();
  let ports: readonly number[] = [];
  const portListeners = new Set<() => void>();
  let closed = false;
  let attempt = 0;
  /** The machine's refusal of the whole tunnel, until a connection is welcomed again. */
  let refused: TunnelRefusalCode | undefined;
  let cancelRetry: (() => void) | undefined;

  const setPorts = (next: readonly number[]) => {
    if (next.length === ports.length && next.every((port, index) => port === ports[index])) return;
    ports = next;
    for (const listener of portListeners) listener();
  };
  const end = (connection: Connection, error: ClientError) => {
    if (connection.ended) return;
    connection.ended = true;
    connection.stopDrain?.();
    for (const waiter of connection.waiting.splice(0)) waiter.reject(error);
    connection.mux?.close();
    connection.lost?.();
    connection.link.close();
    draining.delete(connection);
  };
  const retry = (delayMs: number) => {
    cancelRetry?.();
    cancelRetry = options.schedule(() => {
      cancelRetry = undefined;
      if (!closed && !current) connect();
    }, delayMs);
  };
  const connect = () => {
    const path = options.path.get();
    if (closed || !path) return;
    const connection: Connection = {
      key: path.key,
      link: path.link(),
      mux: undefined,
      waiting: [],
      refusal: undefined,
      refusals: new Map(),
      streams: 0,
      draining: false,
      ended: false,
      frame: undefined,
      lost: undefined,
      stopDrain: undefined,
    };
    current = connection;
    const channel: PreviewChannel = {
      send: (frame) => connection.link.sendBinary(frame),
      close: () => end(connection, new ClientError("offline", "Tunnel closed")),
      subscribe(onFrame, onClose) {
        connection.frame = onFrame;
        connection.lost = onClose;
        return () => {
          connection.frame = undefined;
          connection.lost = undefined;
        };
      },
    };
    connection.link.open({
      ready() {
        if (connection.ended) return;
        attempt = 0;
        refused = undefined;
        connection.mux = createMux({
          channel,
          maxStreams,
          timer: (run, ms) => options.schedule(run, ms),
        });
        for (const waiter of connection.waiting.splice(0)) waiter.resolve();
      },
      message(message) {
        if (connection.ended) return;
        if (message instanceof Uint8Array) {
          connection.frame?.(message);
          return;
        }
        if (message.type === "tunnel.ports") {
          if (connection === current) setPorts(message.ports);
        } else if (message.type === "tunnel.refused") {
          if (message.stream !== undefined) connection.refusals.set(message.stream, message.code);
          else connection.refusal = message.code;
        }
      },
      close() {
        const refusal = connection.refusal;
        end(
          connection,
          new ClientError(refusal ?? "offline", refusal ? "Tunnel refused" : "Tunnel closed"),
        );
        if (connection !== current) return;
        current = undefined;
        if (refusal) {
          // The refusal stands for the next opens until the machine is asked again.
          refused = refusal;
          setPorts([]);
          retry(tunnelRefusedRetryMs);
          return;
        }
        retry(tunnelRetryMs[Math.min(attempt++, tunnelRetryMs.length - 1)] ?? 10_000);
      },
    });
  };
  const drain = (connection: Connection) => {
    connection.draining = true;
    if (connection.streams === 0) {
      end(connection, new ClientError("offline", "Tunnel moved to another path"));
      return;
    }
    draining.add(connection);
    connection.stopDrain = options.schedule(
      () => end(connection, new ClientError("offline", "Tunnel path drained")),
      drainMs,
    );
  };
  const follow = () => {
    if (closed) return;
    const path = options.path.get();
    if (!path) {
      // A lost path resets every stream on it; the browser retries as after any drop.
      cancelRetry?.();
      cancelRetry = undefined;
      const lost = [current, ...draining];
      current = undefined;
      for (const connection of lost)
        if (connection) end(connection, new ClientError("offline", "Machine offline"));
      return;
    }
    if (current?.key === path.key) return;
    const old = current;
    current = undefined;
    if (old) drain(old);
    cancelRetry?.();
    cancelRetry = undefined;
    attempt = 0;
    connect();
  };
  const welcomed = (connection: Connection) =>
    connection.mux
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => connection.waiting.push({ resolve, reject }));
  const stopPath = options.path.subscribe(follow);
  connect();

  return {
    async open(port) {
      const target = PreviewPort.parse(port);
      if (closed) throw new ClientError("offline", "Tunnel closed");
      if (!current && refused) throw new ClientError(refused, "Tunnel refused");
      if (!current) {
        cancelRetry?.();
        cancelRetry = undefined;
        connect();
      }
      const connection = current;
      if (!connection) throw new ClientError("offline", "Machine offline");
      await welcomed(connection);
      const mux = connection.mux;
      if (!mux || connection.ended) throw new ClientError("offline", "Tunnel closed");
      return new Promise<TunnelStream>((resolve, reject) => {
        let id: number | undefined;
        const { socket, stream } = tunnelStream(Readable, {
          opened: () => resolve(stream),
          failed: () => {
            const code =
              (id === undefined ? undefined : connection.refusals.get(id)) ?? connection.refusal;
            if (id !== undefined) connection.refusals.delete(id);
            reject(
              code
                ? new ClientError(code, "Tunnel stream refused")
                : connection.ended
                  ? new ClientError("offline", "Tunnel closed")
                  : id === undefined
                    ? // The mux destroys a stream it has no room for before it has an id.
                      new ClientError("tunnel_limit", "Too many tunnel streams")
                    : new ClientError("tunnel_reset", "Nothing answered on that port"),
            );
          },
        });
        connection.streams++;
        void stream.closed.then(() => {
          connection.streams--;
          if (connection.draining && connection.streams === 0)
            end(connection, new ClientError("offline", "Tunnel path drained"));
        });
        id = mux.open(socket, target);
      });
    },
    ports: {
      get: () => ports,
      subscribe(changed) {
        portListeners.add(changed);
        return () => portListeners.delete(changed);
      },
    },
    close() {
      if (closed) return;
      closed = true;
      stopPath();
      cancelRetry?.();
      const all = [current, ...draining];
      current = undefined;
      for (const connection of all)
        if (connection) end(connection, new ClientError("offline", "Tunnel closed"));
      portListeners.clear();
    },
  };
}
