import type { PreviewChannel } from "@ace/preview";
import type { TunnelRefusalCode, TunnelServerMessage } from "@ace/protocol";
import { tunnelPortsLimit } from "@ace/protocol";
import { TunnelAdmission, tunnelAccess, type TunnelLimits } from "./policy.ts";
import { tunnelPortFeed } from "./port-feed.ts";

/*
 * The machine's tunnel to its loopback (ADR 0194): one per daemon, serving every tunnel
 * connection a device opens, on the direct listeners and the relays alike. Each connection
 * carries `@ace/preview`'s stream mux; this shell admits its opens by `policy.ts`, sends the
 * listening ports, and ends connections the moment their device may no longer use them.
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
  /** Every port an ace process listens on, read when asked (each open, each port scan). */
  acePorts(): Promise<ReadonlySet<number>>;
  /** Every TCP port the machine listens on. */
  listening(): Promise<ReadonlySet<number>>;
  /** Waits `ms` unless `signal` aborts first (the port scan's pause). */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** The clock the open rate is measured on, in ms. */
  now(): number;
  /** Start a loopback stream: `@ace/preview`'s `attachPreviewRelay`, or a test's. */
  attachMux: typeof import("@ace/preview").attachPreviewRelay;
  limits?: TunnelLimits;
  log?(error: unknown): void;
}

export interface TunnelHost {
  /** Serve a welcomed tunnel connection until it closes. */
  attach(connection: TunnelConnection): void;
  /** A device's authority may have changed: end connections that lost `operate`. */
  recheck(): void;
  close(): void;
}

export function createTunnelHost(options: TunnelHostOptions): TunnelHost {
  const admission = new TunnelAdmission(options.now, options.limits);
  const feed = tunnelPortFeed({
    listening: options.listening,
    acePorts: options.acePorts,
    wait: options.wait,
    limit: tunnelPortsLimit,
    onError: (error) => options.log?.(error),
  });
  const live = new Set<{ connection: TunnelConnection; end(code?: TunnelRefusalCode): void }>();
  let enabled: boolean | undefined;
  let closed = false;
  let serial = 0;
  const refuse = (connection: TunnelConnection, code: TunnelRefusalCode) => {
    // The refusal goes first; the connection closes once it is written, or at once if it fails.
    void connection
      .sendJson({ type: "tunnel.refused", code })
      .catch(() => {})
      .finally(() => connection.close());
  };
  const endAll = (code: TunnelRefusalCode | undefined, only?: (c: TunnelConnection) => boolean) => {
    for (const entry of [...live]) if (!only || only(entry.connection)) entry.end(code);
  };
  const stopWatch = options.watchEnabled((next) => {
    enabled = next;
    if (!next) endAll("tunnel_off");
  });
  const readEnabled = async () => (enabled ??= await options.enabled());

  return {
    attach(connection) {
      if (closed) {
        connection.close();
        return;
      }
      const key = `${++serial}`;
      let ended = false;
      let stopPorts: (() => void) | undefined;
      let mux: ReturnType<TunnelHostOptions["attachMux"]> | undefined;
      const entry = {
        connection,
        end(code?: TunnelRefusalCode) {
          if (ended) return;
          ended = true;
          live.delete(entry);
          stopPorts?.();
          // Every stream on it ends with it: the mux resets them as the channel closes.
          mux?.close();
          if (code) refuse(connection, code);
          else connection.close();
        },
      };
      live.add(entry);
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
        mux = options.attachMux({
          channel: connection.channel,
          maxStreams: 512,
          allowPort: async (port, id) => {
            const acePorts = await options.acePorts();
            if (ended) return false;
            const code = admission.admit(connection.device, `${key}:${id}`, {
              enabled: await readEnabled(),
              operate: connection.operate(),
              port,
              acePorts,
            });
            if (!code) return true;
            await connection.sendJson({ type: "tunnel.refused", code, stream: id });
            return false;
          },
          onStreamClosed: (id) => admission.release(connection.device, `${key}:${id}`),
          onClosed: () => entry.end(),
        });
        stopPorts = feed.subscribe((ports) => {
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
      endAll(undefined);
      feed.close();
    },
  };
}
