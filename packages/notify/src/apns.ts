import type { ClientHttp2Session } from "node:http2";
import { connect } from "node:http2";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Notification, NotificationDevice } from "@ace/protocol";
import { createApnsClient } from "./apns-client.ts";
import { httpDeliveryStatus } from "./webpush.ts";
import type { NotificationTransport, DeliveryResult } from "./service.ts";

const Config = z.object({
  teamId: z.string().regex(/^[A-Za-z0-9]{10}$/),
  keyId: z.string().regex(/^[A-Za-z0-9]{10}$/),
  topic: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9.-]+$/),
  privateKey: z.string().max(4096),
  endpoint: z
    .enum(["https://api.push.apple.com", "https://api.sandbox.push.apple.com"])
    .default("https://api.push.apple.com"),
});
export interface ApnsTransport extends NotificationTransport {
  close(): void;
}
/**
 * Direct APNs for self-built apps (ADR 0012): the daemon holds the person's own key. The shipped
 * app uses the push gateway instead (ADR 0106). `open` permits a real h2 test server without
 * weakening endpoint validation.
 */
export function createApnsTransport(
  input: unknown,
  now: () => number,
  open: (endpoint: string) => ClientHttp2Session = connect,
): ApnsTransport {
  const config = Config.parse(input);
  const environment = config.endpoint.includes("sandbox") ? "sandbox" : "production";
  const client = createApnsClient(
    { teamId: config.teamId, keyId: config.keyId, privateKey: config.privateKey },
    now,
    () => open(config.endpoint),
  );
  let closed = false;
  return {
    async send(deviceInput, notificationInput, signal): Promise<DeliveryResult> {
      const device = NotificationDevice.parse(deviceInput);
      const notification = Notification.parse(notificationInput);
      if (closed || device.address.channel !== "apns") return "failed";
      if (signal.aborted) return "retry";
      const payload = Buffer.from(
        JSON.stringify({
          aps: {
            alert: { title: notification.title, body: notification.status },
            sound: "default",
            category: notification.actions.length ? "ACE_APPROVAL" : "ACE_THREAD",
          },
          ace: notification,
        }),
      );
      if (payload.length > 4096) return "failed";
      const response = await client.send(
        {
          environment,
          token: device.address.token,
          topic: config.topic,
          pushType: "alert",
          priority: 10,
          expiration: Math.floor(now() / 1000) + 86400,
          collapseId: createHash("sha256").update(notification.threadId).digest("hex"),
          payload,
        },
        signal,
      );
      return response.status ? httpDeliveryStatus(response.status) : "retry";
    },
    close() {
      closed = true;
      client.close();
    },
  };
}
