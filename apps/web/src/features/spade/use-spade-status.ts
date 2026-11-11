import { onSocketMove, type ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { SpadeStatus } from "@ace/protocol";
import { useSyncExternalStore } from "react";
import { daemonStatusWhileAway, spadeStatusWith, type DirectHealth } from "./spade-route.ts";
import { spadeTransport, type SpadeTransport } from "./spade-transport.ts";

/** How often the desktop app looks at Spade's `/health` itself while someone reads the status. */
const healthEveryMs = 10_000;

/**
 * Spade's state, kept live while someone reads it. The daemon's: `spade.status` once the
 * connection is ready (and again after every reconnect or socket move, since the daemon's watch
 * ends with the socket), then `spade.status.changed` pushes. In the desktop app also Spade's own
 * `/health`, looked at directly (ADR 0123): Spade answering is ready even while the daemon is
 * down. A ready from the daemon stops counting while its connection is gone.
 */
export class SpadeStatusWatch {
  private daemon: SpadeStatus | undefined;
  private direct: DirectHealth | undefined;
  private status: SpadeStatus | undefined;
  private listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private asked = 0;
  private looked = 0;
  private readonly client: ClientApi;
  private readonly transport: Pick<SpadeTransport, "desktop" | "health">;
  constructor(client: ClientApi, transport: Pick<SpadeTransport, "desktop" | "health">) {
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
      // Replies still on their way are for a watch that has ended.
      this.asked++;
      this.looked++;
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
        if (connection.getSnapshot() !== "ready") {
          this.daemonAway();
          return;
        }
        this.ask();
        this.look();
      }),
      onSocketMove(this.client, () => {
        this.ask();
        this.look();
      }),
    );
    // What the daemon said may be from a connection that went while nobody watched.
    if (connection.getSnapshot() === "ready") this.ask();
    else this.daemonAway();
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
    if (!this.transport.desktop) return;
    const looked = ++this.looked;
    void this.transport.health().then((health) => {
      if (looked !== this.looked) return;
      // Undefined: this window shows another machine, whose daemon alone says.
      const direct: DirectHealth | undefined =
        health === undefined
          ? undefined
          : health
            ? { ready: true, version: health.version }
            : { ready: false };
      if (sameHealth(direct, this.direct)) return;
      this.direct = direct;
      this.publish();
    });
  }
  private daemonAway() {
    // A reply still on its way belongs to the connection that's gone.
    this.asked++;
    const kept = daemonStatusWhileAway(this.daemon);
    if (kept === this.daemon) return;
    this.daemon = kept;
    this.publish();
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

const sameHealth = (a: DirectHealth | undefined, b: DirectHealth | undefined) =>
  a?.ready === b?.ready &&
  (a?.ready ? a.version : undefined) === (b?.ready ? b.version : undefined);

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
