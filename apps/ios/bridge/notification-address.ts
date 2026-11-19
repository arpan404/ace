import { PushNotificationAddress, type NotificationAddress } from "@ace/protocol";
import type { z } from "zod";

/**
 * This phone's APNs token, its environment (`sandbox` in Debug builds) and its push key, as
 * Swift sends them in `notifications.sync` once iOS grants a token (ADR 0106).
 */
export const PhonePush = PushNotificationAddress.omit({ channel: true, platform: true });
export type PhonePush = z.infer<typeof PhonePush>;

/** Where a machine sends this phone's alerts: through the push gateway with a key, else its socket. */
export function phoneAddress(push: PhonePush | null): NotificationAddress {
  return push
    ? { channel: "push", platform: "phone", ...push }
    : { channel: "websocket", platform: "phone" };
}

/** The same address: a new token or key is a different one, to register again. */
export function sameAddress(a: NotificationAddress, b: NotificationAddress): boolean {
  if (a.channel === "push" && b.channel === "push")
    return (
      a.token === b.token &&
      a.environment === b.environment &&
      a.p256dh === b.p256dh &&
      a.auth === b.auth
    );
  return a.channel === "websocket" && b.channel === "websocket" && a.platform === b.platform;
}
