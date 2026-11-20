import type { PreviewChannel } from "@ace/preview";
import { maxQueuedBytes } from "@ace/preview/mux";
import type { TunnelRefusalCode, TunnelServerMessage } from "@ace/protocol";
import type { AcePorts } from "./ace-ports.ts";
import { TunnelAdmission, tunnelAccess, type TunnelLimits } from "./policy.ts";
import type { PortWatch } from "./port-feed.ts";

/*
 * The machine's tunnel to its loopback (ADR 0194): one per daemon, serving every tunnel
 * connection a device opens, on the direct listeners and the relays alike. Each connection
 * carries `@ace/preview`'s stream mux; this shell admits its opens by `policy.ts`, keeps them off
 * ace's own ports (`ace-ports.ts`), sends the listening ports, and ends connections the moment
 * their device may no longer use them.
 *
 * An OPEN is decided in three steps. As it arrives, synchronously and before anything is
 * allocated for it: the device's authority, its open rate (every OPEN is charged), its stream
 * limit and the daemon's bound on opens waiting. Then the guard on ace's ports waits for a recent
 * scan, shared by every open. Last, as the socket connects, synchronously: the port must still
 * be known not to be ace's; unknown is refused.
 */

/** One device's tunnel connection, as the path that carries it hands it over once welcomed. */
export interface TunnelConnection {
  /** The device, for its stream limits. */
  device: string;
  /** Whether the device holds `operate` authority now; read at each open and each recheck. */
  operate(): boolean;
  /** Send a JSON message on the connection, in order with its binary frames. */
  sendJson(message: TunnelServerMessage): Promise<void>;
  /** The connection's binary frames: the mux's own channel. */
  channel: PreviewChannel;
  /** End the whole connection (its socket or relay stream). */
  close(): void;
}

export interface TunnelHostOptions {
  /** `remote.machineLocalhost` now. */
  enabled(): Promise<boolean>;
  /** Hear changes of `remote.machineLocalhost`; returns how to stop. */
  watchEnabled(changed: (enabled: boolean) => void): () => void;
  /** Every port an ace process listens on, asked synchronously as each stream connects. */
  acePorts: AcePorts;
  /** The machine's listening ports, one scan for every connection; it keeps `acePorts` fresh. */
  ports: PortWatch;
  /** Waits `ms` unless `signal` aborts first (a refusal's deadline). */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** The clock the open rate is measured on, in ms. */
  now(): number;
  /** The loopback stream mux, loaded on first use: `@ace/preview`'s `attachPreviewRelay`. */
  loadMux(): Promise<typeof import("@ace/preview").attachPreviewRelay>;
  limits?: TunnelLimits;
  /** How long a refusal of a whole connection may take to send before it closes anyway. */
  refusalMs?: number;
  log?(error: unknown): void;
}

export interface TunnelHost {
  /** Serve a welcomed tunnel connection until it closes. */
  attach(connection: TunnelConnection): void;
  /** A device's authority may have changed: end connections that lost `operate`. */
  recheck(): void;
  close(): void;
}

/** A refusal of a whole connection gets this long to reach the device before the close. */
export const tunnelRefusalMs = 2000;

type Entry = {
  connection: TunnelConnection;
  /** Admitted streams and their ports, until their loopback sockets close. */
  streams: Map<number, number>;
  reset(id: number, code?: TunnelRefusalCode): void;
  end(code?: TunnelRefusalCode): void;
};

export function createTunnelHost(options: TunnelHostOptions): TunnelHost {
  const admission = new TunnelAdmission(options.now, options.limits);
  const live = new Set<Entry>();
  let enabled: boolean | undefined;
  let closed = false;
  let serial = 0;
  const endAll = (code: TunnelRefusalCode | undefined, only?: (c: TunnelConnection) => boolean) => {
    for (const entry of live) if (!only || only(entry.connection)) entry.end(code);
  };
  const stopWatch = options.watchEnabled((next) => {
    enabled = next;
    if (!next) endAll("tunnel_off");
  });
  // A port that becomes ace's (Spade started on it, a listener bound) ends every stream to it.
  const stopProtected = options.acePorts.onProtected((port) => {
    for (const entry of live)
      for (const [id, held] of entry.streams)
        if (held === port) entry.reset(id, "tunnel_port_refused");
  });
  const readEnabled = async () => (enabled ??= await options.enabled());

  return {
    attach(connection) {
      if (closed) {
        connection.close();
        return;
      }
      const key = `${++serial}`;
      const name = (id: number) => `${key}:${id}`;
      let ended = false;
      let stopPorts: (() => void) | undefined;
      let mux: ReturnType<Awaited<ReturnType<TunnelHostOptions["loadMux"]>>> | undefined;
      const refuseStream = (id: number, code: TunnelRefusalCode) => {
        // Queued ahead of the stream's RESET, on the connection's one ordered queue.
        void connection.sendJson({ type: "tunnel.refused", code, stream: id }).catch(() => {});
      };
      const entry: Entry = {
        connection,
        streams: new Map(),
        reset(id, code) {
          if (code) refuseStream(id, code);
          mux?.reset(id);
        },
        end(code) {
          if (ended) return;
          ended = true;
          live.delete(entry);
          stopPorts?.();
          const finish = () => {
            // Every stream left on it ends with it: the mux resets them as the channel closes.
            mux?.close();
            connection.close();
          };
          if (!code) {
            finish();
            return;
          }
          // The refusal goes first, then every TCP stream ends at once, before the refusal is
          // even written; the connection closes once it is, or at the deadline.
          const sent = connection.sendJson({ type: "tunnel.refused", code }).catch(() => {});
          // Removing a stream deletes it from the map; iterating a Map tolerates that.
          for (const id of entry.streams.keys()) mux?.reset(id);
          const deadline = new AbortController();
          void Promise.race([
            sent,
            options.wait(options.refusalMs ?? tunnelRefusalMs, deadline.signal),
          ])
            .catch(() => {})
            .finally(() => {
              deadline.abort();
              finish();
            });
        },
      };
      live.add(entry);
      const channel = heldChannel(connection.channel, () => entry.end());
      // Authority is decided before any frame is handled: frames wait in `heldChannel` until
      // the mux subscribes, which only an admitted connection reaches.
      const now = tunnelAccess({ enabled: enabled ?? true, operate: connection.operate() });
      if (now) {
        entry.end(now);
        return;
      }
      void (async () => {
        const access = tunnelAccess({
          enabled: await readEnabled(),
          operate: connection.operate(),
        });
        if (ended) return;
        if (access) {
          entry.end(access);
          return;
        }
        const attachMux = await options.loadMux();
        if (ended) return;
        mux = attachMux({
          channel,
          maxStreams: 512,
          maxQueuedBytes,
          admitOpen: (port, id) => {
            if (ended) return false;
            const code = admission.admit(connection.device, name(id), {
              enabled: enabled !== false,
              operate: connection.operate(),
            });
            if (code) {
              refuseStream(id, code);
              return false;
            }
            entry.streams.set(id, port);
            return true;
          },
          allowPort: async (port, id) => {
            try {
              await options.ports.fresh();
              // Reset while it waited: its slot is already free, and it is never dialed.
              if (ended || !admission.holds(connection.device, name(id))) return false;
              if (options.acePorts.ownership(port) === "free") return true;
              refuseStream(id, "tunnel_port_refused");
              return false;
            } finally {
              admission.authorized(connection.device, name(id));
            }
          },
          canConnect: (port, id) => {
            if (ended) return false;
            if (options.acePorts.ownership(port) === "free") return true;
            refuseStream(id, "tunnel_port_refused");
            return false;
          },
          onStreamClosed: (id) => {
            entry.streams.delete(id);
            admission.release(connection.device, name(id));
          },
          onClosed: () => entry.end(),
        });
        stopPorts = options.ports.subscribe((ports) => {
          void connection.sendJson({ type: "tunnel.ports", ports }).catch(() => entry.end());
        });
      })().catch((error: unknown) => {
        options.log?.(error);
        entry.end();
      });
    },
    recheck() {
      endAll("tunnel_forbidden", (connection) => !connection.operate());
    },
    close() {
      if (closed) return;
      closed = true;
      stopWatch();
      stopProtected();
      endAll(undefined);
      options.ports.close();
    },
  };
}

/** OPENs a device may send before the mux has started: the first page load's connections. */
const heldFramesLimit = 512;

/**
 * `channel`, listened to from the moment the connection is handed over. The device sends OPEN
 * frames as soon as it is welcomed, while the host still reads the setting and loads the mux,
 * so frames that come first are held (at most `heldFramesLimit`, past which the connection
 * ends) and handed to the mux when it subscribes, in order.
 */
function heldChannel(channel: PreviewChannel, end: () => void): PreviewChannel {
  const held: Uint8Array[] = [];
  let lost = false;
  let deliver: ((frame: Uint8Array) => void) | undefined;
  let closed: (() => void) | undefined;
  const stop = channel.subscribe(
    (frame) => {
      if (deliver) deliver(frame);
      else if (held.length < heldFramesLimit) held.push(frame);
      else end();
    },
    () => {
      lost = true;
      if (closed) closed();
      else end();
    },
  );
  return {
    send: (frame) => channel.send(frame),
    close: () => channel.close(),
    get bufferedBytes() {
      return channel.bufferedBytes ?? 0;
    },
    get bufferedReceiveBytes() {
      return channel.bufferedReceiveBytes ?? 0;
    },
    subscribe(onFrame, onClose) {
      deliver = onFrame;
      closed = onClose;
      for (const frame of held.splice(0)) onFrame(frame);
      if (lost) onClose();
      return stop;
    },
  };
}
