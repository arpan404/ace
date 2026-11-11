import { onSocketMove, type ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { SpadeStatus } from "@ace/protocol";
import { useSyncExternalStore } from "react";

/**
 * Spade's state on this daemon, kept live while someone reads it: `spade.status` once the
 * connection is ready (and again after every reconnect or socket move, since the daemon's watch
 * ends with the socket), then `spade.status.changed` pushes.
 */
class SpadeStatusWatch {
  private status: SpadeStatus | undefined;
  private listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private asked = 0;
  private readonly client: ClientApi;
  constructor(client: ClientApi) {
    this.client = client;
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
          if (message.type === "spade.status.changed") this.set(message.status);
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
  }
  private ask() {
    if (this.client.state !== "ready") return;
    const asked = ++this.asked;
    void this.client.request({ type: "spade.status" }).then(
      (reply) => {
        if (asked === this.asked) this.set(reply.status);
      },
      () => {},
    );
  }
  private set(status: SpadeStatus) {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}

const watches = new WeakMap<ClientApi, SpadeStatusWatch>();

/** Spade's status, undefined until the daemon first answers. */
export function useSpadeStatus(): SpadeStatus | undefined {
  const client = useClient();
  let watch = watches.get(client);
  if (!watch) {
    watch = new SpadeStatusWatch(client);
    watches.set(client, watch);
  }
  return useSyncExternalStore(watch.subscribe, watch.get, watch.get);
}
