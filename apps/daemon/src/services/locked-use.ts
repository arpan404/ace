import type { LockedUseObservation } from "@ace/protocol";
import {
  LockedUseBusyError,
  type LockedUseAction,
  type LockedUseState,
} from "../locked-use-state.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** Locked use subscriptions one socket may hold, within the socket's shared limit. */
const maxSubscriptions = 8;
/** Subscriptions of every family one socket may hold (the same bound settings and reads use). */
const maxSocketSubscriptions = 64;
const actions = {
  "lockedUse.install": "install",
  "lockedUse.remove": "remove",
  "lockedUse.repair": "repair",
} as const satisfies Record<string, LockedUseAction>;

interface Subscription {
  /** The highest revision sent; -1 before the snapshot, so nothing is pushed until then. */
  sent: number;
  /** Its entry in the socket's shared subscription table. */
  stop(): void;
}

/**
 * `lockedUse.*`: this Mac's locked computer use state. A subscribe replies with
 * `lockedUse.status`, then pushes `lockedUse.changed` with ever higher revisions; subscribing
 * again with the same id replaces the subscription with a fresh snapshot. Install, remove and
 * repair need admin and reply with `lockedUse.result` carrying the newest state.
 */
export function createLockedUseSession(
  context: SocketContext,
  state: LockedUseState,
): SocketService {
  const subscriptions = new Map<string, Subscription>();
  let stopWatching: (() => void) | undefined;
  let closed = false;

  const push = (subscriptionId: string, subscription: Subscription, next: LockedUseObservation) => {
    if (subscription.sent < 0 || next.revision <= subscription.sent) return;
    if (closed || !context.connected() || !context.authorize("read")) return;
    subscription.sent = next.revision;
    context.send({ type: "lockedUse.changed", subscriptionId, ...next });
  };
  const forget = (subscriptionId: string, subscription: Subscription) => {
    if (subscriptions.get(subscriptionId) !== subscription) return;
    subscriptions.delete(subscriptionId);
    if (context.subscriptions.get(subscriptionId) === subscription.stop)
      context.subscriptions.delete(subscriptionId);
    if (subscriptions.size || !stopWatching) return;
    stopWatching();
    stopWatching = undefined;
  };

  async function subscribe(requestId: string, subscriptionId: string) {
    if (!context.authorize("read")) {
      context.fail("forbidden", "Read scope required", false, { requestId });
      return;
    }
    // The same id again replaces what it named, so a client can renew after a lost reply.
    context.subscriptions.get(subscriptionId)?.();
    context.subscriptions.delete(subscriptionId);
    if (
      subscriptions.size >= maxSubscriptions ||
      context.subscriptions.size >= maxSocketSubscriptions
    ) {
      context.fail("limit", "Too many subscriptions", false, { requestId });
      return;
    }
    const subscription: Subscription = {
      sent: -1,
      stop: () => forget(subscriptionId, subscription),
    };
    const stop = subscription.stop;
    subscriptions.set(subscriptionId, subscription);
    context.subscriptions.set(subscriptionId, stop);
    stopWatching ??= state.watch((next) => {
      for (const [id, each] of subscriptions) push(id, each, next);
    });
    try {
      const snapshot = await state.refresh();
      if (closed) return;
      if (subscriptions.get(subscriptionId) !== subscription) {
        context.fail("cancelled", "Unsubscribed before the first status", false, { requestId });
        return;
      }
      if (!context.connected() || !context.authorize("read")) return stop();
      // The newest state, which is at least as new as anything pushed while reading.
      subscription.sent = snapshot.revision;
      context.send({ type: "lockedUse.status", requestId, subscriptionId, ...snapshot });
    } catch {
      stop();
      if (!closed && context.connected())
        context.fail("unavailable", "Couldn't read locked use", false, { requestId });
    }
  }

  async function act(requestId: string, action: LockedUseAction) {
    const reply = (
      fields: { ok: boolean; code?: string; reason?: string } & Partial<LockedUseObservation>,
    ) => {
      if (!closed && context.connected())
        context.send({ type: "lockedUse.result", requestId, ...fields });
    };
    if (!context.authorize("admin"))
      return reply({
        ok: false,
        code: "forbidden",
        reason: "Only this Mac's owner can change this.",
      });
    try {
      reply({ ok: true, ...(await state.run(action)) });
    } catch (error) {
      if (error instanceof LockedUseBusyError)
        return reply({ ok: false, code: "busy", reason: "Another change is running." });
      const newest = await state.refresh().catch(() => state.current);
      reply({
        ok: false,
        code: "failed",
        reason: error instanceof Error ? error.message : `Locked use ${action} failed`,
        ...newest,
      });
    }
  }

  return {
    close() {
      closed = true;
      for (const [id, subscription] of subscriptions) forget(id, subscription);
      stopWatching?.();
      stopWatching = undefined;
    },
    handle(message) {
      switch (message.type) {
        case "lockedUse.subscribe":
          void subscribe(message.requestId, message.subscriptionId);
          return true;
        case "lockedUse.unsubscribe": {
          const subscription = subscriptions.get(message.subscriptionId);
          if (subscription) forget(message.subscriptionId, subscription);
          context.send({ type: "lockedUse.result", requestId: message.requestId, ok: true });
          return true;
        }
        case "lockedUse.install":
        case "lockedUse.remove":
        case "lockedUse.repair":
          void act(message.requestId, actions[message.type]);
          return true;
        default:
          return false;
      }
    },
  };
}
