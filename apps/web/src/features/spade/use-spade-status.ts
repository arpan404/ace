import { onSocketMove, type ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { SpadeStatus } from "@ace/protocol";
import { useSyncExternalStore } from "react";
import { spadeStatusWith, type DirectHealth } from "./spade-route.ts";
import { spadeTransport, type SpadeTransport } from "./spade-transport.ts";

/** How often the desktop app looks at Spade's `/health` itself while someone reads the status. */
const healthEveryMs = 10_000;

/**
 * Spade's state, kept live while someone reads it. The daemon's: `spade.status` once the
 * connection is ready (and again after every reconnect or socket move, since the daemon's watch
 * ends with the socket), then `spade.status.changed` pushes. In the desktop app also Spade's own
 * `/health`, looked at directly (ADR 0123): Spade answering is ready even while the daemon is
 * down.
 */
class SpadeStatusWatch {
  private daemon: SpadeStatus | undefined;
  private direct: DirectHealth | undefined;
  private status: SpadeStatus | undefined;
  private listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private asked = 0;
  private looked = 0;
  private readonly client: ClientApi;
  private readonly transport: SpadeTransport;
  constructor(client: ClientApi, transport: SpadeTransport) {
    this.client = client;
    this.transport = transport;
  }
  get = (): SpadeStatus | undefined => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      for (const stop of this.stops.splice(0)) stop();
    };
  };
  private start() {
    const connection = this.client.connectionState();
    try {
      this.stops.push(
        this.client.onMessage((message) => {
          if (message.type === "spade.status.changed") this.setDaemon(message.status);
        }),
      );
    } catch {
      // At the listener limit the status only refreshes on reconnect.
    }
    this.stops.push(
      connection.subscribe(() => {
        if (connection.getSnapshot() === "ready") this.ask();
      }),
      onSocketMove(this.client, () => this.ask()),
    );
    this.ask();
    this.watchDirect();
  }
  private watchDirect() {
    const desktop = this.transport.desktop;
    if (!desktop) return;
    const timer = setInterval(() => this.look(), healthEveryMs);
    this.stops.push(
      desktop.onEndpointChanged(() => this.look()),
      () => clearInterval(timer),
    );
    this.look();
  }
  private ask() {
    if (this.client.state !== "ready") return;
    const asked = ++this.asked;
    void this.client.request({ type: "spade.status" }).then(
      (reply) => {
        if (asked === this.asked) this.setDaemon(reply.status);
      },
      () => {},
    );
  }
  private look() {
    const looked = ++this.looked;
    void this.transport.health().then((health) => {
      if (looked !== this.looked || health === undefined) return;
      const direct: DirectHealth = health
        ? { ready: true, version: health.version }
        : { ready: false };
      if (direct.ready === this.direct?.ready && health?.version === this.directVersion()) return;
      this.direct = direct;
      this.publish();
    });
  }
  private directVersion() {
    return this.direct?.ready ? this.direct.version : undefined;
  }
  private setDaemon(status: SpadeStatus) {
    this.daemon = status;
    this.publish();
  }
  private publish() {
    this.status = spadeStatusWith(this.daemon, this.direct);
    for (const listener of this.listeners) listener();
  }
}

const watches = new WeakMap<ClientApi, SpadeStatusWatch>();

/** Spade's status, undefined until the daemon or (in the desktop app) Spade first answers. */
export function useSpadeStatus(): SpadeStatus | undefined {
  const client = useClient();
  let watch = watches.get(client);
  if (!watch) {
    watch = new SpadeStatusWatch(client, spadeTransport(client));
    watches.set(client, watch);
  }
  return useSyncExternalStore(watch.subscribe, watch.get, watch.get);
}
