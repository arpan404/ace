import type { LockedUseStatus } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import type { RetryTimers } from "./settings-subscription.ts";

/** What a locked use subscription needs from the connection. */
export type LockedUseOwner = Pick<ClientApi, "state" | "connectionState" | "request" | "onMessage">;

/**
 * Follow this Mac's locked computer use state: a `lockedUse.subscribe` while connected, renewed
 * after every reconnect, then `lockedUse.changed` pushes. A failed read retries with backoff
 * while the connection stays ready. `receive` gets the snapshot, then every later state.
 * `subscriptionId` must be unique on the socket.
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
  // A push that beats the snapshot reply is newer than it.
  let pushed: LockedUseStatus | undefined;
  const ask = () => {
    if (stopped || subscribed || client.state !== "ready") return;
    subscribed = true;
    const current = ++generation;
    pushed = undefined;
    void client
      .request({ type: "lockedUse.subscribe", subscriptionId })
      .then((reply) => {
        if (stopped || generation !== current) return;
        attempts = 0;
        receive(pushed ?? reply.status);
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
      pushed = message.status;
      receive(message.status);
    }),
    connection.subscribe(() => {
      if (connection.getSnapshot() !== "ready") {
        subscribed = false;
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
