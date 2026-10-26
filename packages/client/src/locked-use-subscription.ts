import type { LockedUseStatus } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import type { RetryTimers } from "./settings-subscription.ts";

/** What a locked use subscription needs from the connection. */
export type LockedUseOwner = Pick<ClientApi, "state" | "connectionState" | "request" | "onMessage">;

/**
 * Follow this Mac's locked computer use state: a `lockedUse.subscribe` while connected, renewed
 * after every reconnect, then `lockedUse.changed` pushes. A failed read retries with backoff
 * while the connection stays ready, renewing under the same id (the daemon replaces it).
 * `receive` gets each state once, in order: a snapshot or push no newer than one already
 * delivered on this connection is dropped. `subscriptionId` must be unique on the socket.
 */
export function subscribeLockedUse(
  client: LockedUseOwner,
  subscriptionId: string,
  receive: (status: LockedUseStatus) => void,
  failed: () => void,
  timers: RetryTimers,
) {
  let stopped = false;
  let subscribed = false;
  let generation = 0;
  let attempts = 0;
  let cancel: (() => void) | undefined;
  // The highest revision delivered on this connection; revisions restart with the daemon.
  let delivered = -1;
  const deliver = (revision: number, status: LockedUseStatus) => {
    if (revision <= delivered) return;
    delivered = revision;
    receive(status);
  };
  const ask = () => {
    if (stopped || subscribed || client.state !== "ready") return;
    subscribed = true;
    const current = ++generation;
    void client
      .request({ type: "lockedUse.subscribe", subscriptionId })
      .then((reply) => {
        if (stopped || generation !== current) return;
        attempts = 0;
        deliver(reply.revision, reply.status);
      })
      .catch(() => {
        if (stopped || generation !== current) return;
        subscribed = false;
        failed();
        cancel = timers.set(Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)), ask);
      });
  };
  const connection = client.connectionState();
  const stops = [
    client.onMessage((message) => {
      if (message.type !== "lockedUse.changed" || message.subscriptionId !== subscriptionId) return;
      if (!stopped) deliver(message.revision, message.status);
    }),
    connection.subscribe(() => {
      if (connection.getSnapshot() !== "ready") {
        subscribed = false;
        delivered = -1;
        generation++;
        cancel?.();
      } else ask();
    }),
  ];
  ask();
  return {
    retry() {
      cancel?.();
      subscribed = false;
      ask();
    },
    stop() {
      stopped = true;
      cancel?.();
      for (const stop of stops) stop();
      if (client.state === "ready")
        void client.request({ type: "lockedUse.unsubscribe", subscriptionId }).catch(() => {});
    },
  };
}
