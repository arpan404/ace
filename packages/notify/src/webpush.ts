import { createECDH, randomBytes } from "node:crypto";
import { z } from "zod";
import { Notification, NotificationDevice } from "@ace/protocol";
import { encryptWebPush, p256SigningKey, vapidAuthorization } from "./webpush-crypto.ts";
import type { NotificationTransport, DeliveryResult } from "./service.ts";

const Config = z.object({
  privateKey: z.string().max(4096),
  subject: z
    .string()
    .max(256)
    .refine((value) => /^(mailto:|https:\/\/)/.test(value)),
  allowedOrigins: z.array(z.url()).min(1).max(32),
});
export function httpDeliveryStatus(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500) return "retry";
  return "failed";
}
export function createWebPushTransport(
  input: unknown,
  now: () => number,
  request: typeof fetch = fetch,
): NotificationTransport {
  const config = Config.parse(input);
  const key = p256SigningKey(config.privateKey);
  const origins = new Set(
    config.allowedOrigins.map((value) => {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Web Push allowlist requires HTTPS origins");
      return url.origin;
    }),
  );
  const tokens = new Map<string, { value: string; at: number }>();
  return {
    async send(deviceInput, notificationInput, signal) {
      const device = NotificationDevice.parse(deviceInput);
      const notification = Notification.parse(notificationInput);
      if (device.address.channel !== "webpush") return "failed";
      const subscription = device.address.subscription;
      const url = new URL(subscription.endpoint);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !origins.has(url.origin)
      )
        return "failed";
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      const body = encryptWebPush({
        subscription,
        plaintext: Buffer.from(JSON.stringify(notification)),
        salt: randomBytes(16),
        privateKey: ecdh.getPrivateKey(),
      });
      const at = now();
      let token = tokens.get(url.origin);
      if (!token || at - token.at >= 55 * 60_000 || at < token.at) {
        token = { at, value: vapidAuthorization(key, url.href, config.subject, at) };
        tokens.set(url.origin, token);
      }
      const response = await request(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: {
          "content-type": "application/octet-stream",
          "content-encoding": "aes128gcm",
          TTL: "86400",
          Authorization: token.value,
        },
        body,
      });
      // Response payload is not needed; do not buffer arbitrary vendor bodies.
      await response.body?.cancel();
      return httpDeliveryStatus(response.status);
    },
  };
}
