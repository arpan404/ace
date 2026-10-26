import { LockedUseStatus } from "@ace/protocol";
import type { LockedUseInstaller } from "@ace/screen";
import type { SocketContext, SocketService } from "./socket.ts";

/** Subscriptions one socket may hold. */
const maxSubscriptions = 8;
const actions = {
  "lockedUse.install": "install",
  "lockedUse.remove": "remove",
  "lockedUse.repair": "repair",
} as const;

interface Subscription {
  /** Encoded last status sent, so a repeat isn't pushed twice. */
  last: string | undefined;
  /** Until the first snapshot is sent, changes wait here; only the newest matters. */
  pending: LockedUseStatus | undefined;
  ready: boolean;
}

/**
 * `lockedUse.*`: this Mac's locked computer use state as the installer detects it. A subscribe
 * replies with `lockedUse.status`, then pushes `lockedUse.changed`; install, remove and repair
 * need admin and reply with `lockedUse.result`, then push the new state to this socket's
 * subscriptions.
 */
export function createLockedUseSession(
  context: SocketContext,
  installer: LockedUseInstaller,
): SocketService {
  const subscriptions = new Map<string, Subscription>();
  let stopInstaller: (() => void) | undefined;
  let acting = false;
  let closed = false;

  const push = (subscriptionId: string, value: unknown) => {
    const subscription = subscriptions.get(subscriptionId);
    const parsed = LockedUseStatus.safeParse(value);
    if (!subscription || !parsed.success || closed || !context.connected()) return;
    if (!subscription.ready) {
      subscription.pending = parsed.data;
      return;
    }
    if (!context.authorize("read")) return;
    const encoded = JSON.stringify(parsed.data);
    if (encoded === subscription.last) return;
    subscription.last = encoded;
    context.send({ type: "lockedUse.changed", subscriptionId, status: parsed.data });
  };
  const broadcast = (status: unknown) => {
    for (const subscriptionId of subscriptions.keys()) push(subscriptionId, status);
  };
  const remove = (subscriptionId: string) => {
    subscriptions.delete(subscriptionId);
    if (subscriptions.size || !stopInstaller) return;
    stopInstaller();
    stopInstaller = undefined;
  };

  async function subscribe(requestId: string, subscriptionId: string) {
    if (!context.authorize("read")) {
      context.fail("forbidden", "Read scope required", false, { requestId });
      return;
    }
    if (subscriptions.has(subscriptionId) || subscriptions.size >= maxSubscriptions) {
      context.fail("limit", "Too many locked use subscriptions", false, { requestId });
      return;
    }
    const subscription: Subscription = { last: undefined, pending: undefined, ready: false };
    subscriptions.set(subscriptionId, subscription);
    try {
      stopInstaller ??= installer.subscribe(broadcast);
      const status = LockedUseStatus.parse(await installer.detectStatus());
      if (closed) return;
      if (subscriptions.get(subscriptionId) !== subscription) {
        context.fail("cancelled", "Unsubscribed before the first status", false, { requestId });
        return;
      }
      if (!context.connected() || !context.authorize("read")) return remove(subscriptionId);
      subscription.last = JSON.stringify(status);
      subscription.ready = true;
      context.send({ type: "lockedUse.status", requestId, subscriptionId, status });
      const pending = subscription.pending;
      subscription.pending = undefined;
      if (pending) push(subscriptionId, pending);
    } catch {
      if (subscriptions.get(subscriptionId) === subscription) remove(subscriptionId);
      if (!closed && context.connected())
        context.fail("unavailable", "Couldn't read locked use", false, { requestId });
    }
  }

  async function act(requestId: string, action: "install" | "remove" | "repair") {
    const reply = (fields: {
      ok: boolean;
      status?: LockedUseStatus;
      code?: string;
      reason?: string;
    }) => {
      if (!closed && context.connected())
        context.send({ type: "lockedUse.result", requestId, ...fields });
    };
    if (!context.authorize("admin"))
      return reply({
        ok: false,
        code: "forbidden",
        reason: "Only this Mac's owner can change this.",
      });
    if (acting) return reply({ ok: false, code: "busy", reason: "Another change is running." });
    acting = true;
    try {
      const status = LockedUseStatus.parse(await installer[action]());
      reply({ ok: true, status });
      broadcast(status);
    } catch (error) {
      const status = await installer.detectStatus().then(
        (value) => LockedUseStatus.safeParse(value).data,
        () => undefined,
      );
      reply({
        ok: false,
        code: "failed",
        reason: error instanceof Error ? error.message : `Locked use ${action} failed`,
        ...(status ? { status } : {}),
      });
      if (status) broadcast(status);
    } finally {
      acting = false;
    }
  }

  return {
    close() {
      closed = true;
      subscriptions.clear();
      stopInstaller?.();
      stopInstaller = undefined;
    },
    handle(message) {
      switch (message.type) {
        case "lockedUse.subscribe":
          void subscribe(message.requestId, message.subscriptionId);
          return true;
        case "lockedUse.unsubscribe":
          remove(message.subscriptionId);
          context.send({ type: "lockedUse.result", requestId: message.requestId, ok: true });
          return true;
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
