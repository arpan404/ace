import { connect, type ClientHttp2Session } from "node:http2";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Notification, NotificationDevice } from "@ace/protocol";
import { p256SigningKey, signJwt } from "./webpush-crypto.ts";
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
/** The injectable connector permits a real h2 test server without weakening endpoint validation. */
export function createApnsTransport(
  input: unknown,
  now: () => number,
  open: (endpoint: string) => ClientHttp2Session = connect,
): ApnsTransport {
  const config = Config.parse(input);
  const key = p256SigningKey(config.privateKey);
  let session: ClientHttp2Session | undefined;
  let token: { value: string; at: number } | undefined;
  let active = 0;
  let closed = false;
  const getSession = () => {
    if (!session || session.closed || session.destroyed) {
      session = open(config.endpoint);
      const owned = session;
      owned.on("error", () => {
        owned.destroy();
      });
      owned.on("goaway", () => {
        owned.close();
        if (session === owned) session = undefined;
      });
      owned.setTimeout(60_000, () => owned.close());
    }
    return session;
  };
  return {
    async send(deviceInput, notificationInput, signal): Promise<DeliveryResult> {
      const device = NotificationDevice.parse(deviceInput);
      const notification = Notification.parse(notificationInput);
      if (closed || device.address.channel !== "apns") return "failed";
      if (signal.aborted || active >= 16) return "retry";
      const at = now();
      if (!token || at - token.at >= 50 * 60_000 || at < token.at)
        token = {
          at,
          value: signJwt(
            key,
            { alg: "ES256", kid: config.keyId },
            { iss: config.teamId, iat: Math.floor(at / 1000) },
          ),
        };
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
      active++;
      try {
        const stream = getSession().request({
          ":method": "POST",
          ":path": `/3/device/${device.address.token}`,
          authorization: `bearer ${token.value}`,
          "apns-topic": config.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(at / 1000) + 86400),
          "apns-collapse-id": createHash("sha256").update(notification.threadId).digest("hex"),
        });
        return await new Promise<DeliveryResult>((resolve) => {
          let status = 0;
          let bytes = 0;
          let finished = false;
          const finish = (result: DeliveryResult) => {
            if (finished) return;
            finished = true;
            signal.removeEventListener("abort", abort);
            resolve(result);
            stream.close();
          };
          const abort = () => finish("retry");
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            abort();
            return;
          }
          stream.setTimeout(10_000, abort);
          stream.on("response", (headers) => {
            const parsed = z.coerce.number().int().min(100).max(599).safeParse(headers[":status"]);
            status = parsed.success ? parsed.data : 0;
          });
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4096) finish("failed");
          });
          stream.on("error", () => finish("retry"));
          stream.on("end", () => finish(status ? httpDeliveryStatus(status) : "retry"));
          stream.on("close", () => finish("retry"));
          stream.end(payload);
        });
      } finally {
        active--;
      }
    },
    close() {
      closed = true;
      session?.destroy();
      session = undefined;
    },
  };
}
