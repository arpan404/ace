import type { Server } from "node:net";
import { processListeningPorts } from "@ace/preview/detection";
import type { SettingsService } from "@ace/settings";
import { acePortReader } from "./ace-ports.ts";
import { createTunnelHost, type TunnelHost } from "./host.ts";

const key = "remote.machineLocalhost";

/** What the daemon composes the tunnel from: the I/O edges `host.ts` takes. */
export interface MachineTunnelWiring {
  settings: SettingsService | undefined;
  /** Every listener the daemon holds now (loopback, remote, LAN, Tailscale): read live. */
  listeners(): Iterable<Server>;
  /** Other ace listeners' ports now: the preview gateway's, Spade's. */
  otherPorts(): Iterable<number | undefined>;
  /** ace processes besides the daemon: Spade's service, ace-media. */
  otherPids(): Iterable<number | undefined>;
  /** Hear a device's scopes change. */
  onRescope(changed: () => void): () => void;
  log?(error: unknown): void;
}

const portOf = (server: Server) => {
  const address = server.listening ? server.address() : null;
  return address && typeof address !== "string" ? address.port : undefined;
};

/** The daemon's tunnel host, on the real OS, clock and settings. */
export function startMachineTunnel(wiring: MachineTunnelWiring): TunnelHost {
  const acePorts = acePortReader({
    listeners: () => [...[...wiring.listeners()].map(portOf), ...wiring.otherPorts()],
    pids: () => [
      process.pid,
      ...[...wiring.otherPids()].filter((pid): pid is number => pid !== undefined),
    ],
    scan: (pids) => processListeningPorts(pids),
    now: () => performance.now(),
    ...(wiring.log ? { onError: wiring.log } : {}),
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
    listening: async () => (await import("@ace/preview")).discoverListeningPorts(),
    wait: (ms, signal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      }),
    now: () => performance.now(),
    loadMux: async () => (await import("@ace/preview")).attachPreviewRelay,
    ...(wiring.log ? { log: wiring.log } : {}),
  });
  const stopRescope = wiring.onRescope(() => host.recheck());
  return {
    attach: host.attach,
    recheck: host.recheck,
    close() {
      stopRescope();
      host.close();
    },
  };
}
