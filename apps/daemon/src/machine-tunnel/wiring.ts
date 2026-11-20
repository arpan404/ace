import { tracingChannel } from "node:diagnostics_channel";
import { Server } from "node:net";
import { scanListeningPorts } from "@ace/preview/detection";
import { tunnelPortsLimit } from "@ace/protocol";
import type { SettingsService } from "@ace/settings";
import { AcePorts } from "./ace-ports.ts";
import { createTunnelHost, type TunnelHost } from "./host.ts";
import { machinePortWatch } from "./port-feed.ts";

const key = "remote.machineLocalhost";

/** What the daemon composes the tunnel from: the I/O edges `host.ts` takes. */
export interface MachineTunnelWiring {
  settings: SettingsService | undefined;
  /** Ports other ace listeners publish, read live: the preview gateway's, Spade's. */
  otherPorts(): Iterable<number | undefined>;
  /** ace processes besides the daemon: Spade's service, ace-media. */
  otherPids(): Iterable<number | undefined>;
  /** Hear a device's scopes change. */
  onRescope(changed: () => void): () => void;
  log?(error: unknown): void;
}

/** The daemon's tunnel, and how its own listeners are held as ace's from the moment they bind. */
export interface MachineTunnel extends TunnelHost {
  /** Holds `server`'s port as ace's whenever it listens, from the bind, until it closes. */
  track(server: Server): void;
}

const now = () => performance.now();
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const portOf = (server: Server) => {
  const address = server.listening ? server.address() : null;
  return address && typeof address !== "string" ? address.port : undefined;
};

/** The daemon's tunnel host, on the real OS, clock and settings. */
export function startMachineTunnel(wiring: MachineTunnelWiring): MachineTunnel {
  const acePorts = new AcePorts({ published: wiring.otherPorts, now });
  const tracked = new WeakSet<Server>();
  const track = (server: Server) => {
    if (tracked.has(server)) return;
    tracked.add(server);
    let release: (() => void) | undefined;
    const bound = () => {
      const port = portOf(server);
      const next = port === undefined ? undefined : acePorts.hold(port);
      release?.();
      release = next;
    };
    // `listening` comes right after the bind, ahead of any connection it accepts.
    server.prependListener("listening", bound);
    server.on("close", () => {
      release?.();
      release = undefined;
    });
    if (server.listening) bound();
  };
  // Every server in this process is ace's (a dev server is always another process). On Node the
  // listen tracing channel reports each one as it binds, before `listening` and before it can
  // accept, so even servers no list names are held at once. Bun reports nothing there; its
  // `listen` binds synchronously, and the named listeners and the scan cover it.
  const listens = tracingChannel("net.server.listen");
  const onListen = {
    asyncEnd(message: unknown) {
      const server = (message as { server?: unknown } | undefined)?.server;
      if (server instanceof Server) track(server);
    },
  };
  listens.subscribe(onListen);
  const ports = machinePortWatch({
    scan: () =>
      scanListeningPorts([
        process.pid,
        ...[...wiring.otherPids()].filter((pid): pid is number => pid !== undefined),
      ]),
    acePorts,
    now,
    wait,
    limit: tunnelPortsLimit,
    onError: (error) => wiring.log?.(error),
  });
  const host = createTunnelHost({
    enabled: async () => {
      const entry = await wiring.settings?.get(key).catch(() => undefined);
      // Unreadable settings keep the default, which is on.
      return entry?.value !== false;
    },
    watchEnabled(changed) {
      let stop: (() => void) | undefined;
      let stopped = false;
      void wiring.settings
        ?.subscribe({ keys: [key], scope: {} }, (notification) => {
          if (notification.type !== "changed") return;
          const entry = notification.entries.find((each) => each.key === key);
          if (entry) changed(entry.value !== false);
        })
        .then((unsubscribe) => {
          if (stopped) unsubscribe();
          else stop = unsubscribe;
        })
        .catch((error: unknown) => wiring.log?.(error));
      return () => {
        stopped = true;
        stop?.();
      };
    },
    acePorts,
    ports,
    wait,
    now,
    loadMux: async () => (await import("@ace/preview")).attachPreviewRelay,
    ...(wiring.log ? { log: wiring.log } : {}),
  });
  const stopRescope = wiring.onRescope(() => host.recheck());
  return {
    attach: host.attach,
    recheck: host.recheck,
    track,
    close() {
      listens.unsubscribe(onListen);
      stopRescope();
      host.close();
    },
  };
}
