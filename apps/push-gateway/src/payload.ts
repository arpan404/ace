import { z } from "zod";

export const maxBody = 2800;
/** The smallest RFC 8291 record: 86-byte header, one padding byte and the 16-byte tag. */
const minBody = 103;
const Urgency = z.enum(["very-low", "low", "normal", "high"]).default("normal");
const Ttl = z
  .string()
  .regex(/^[0-9]{1,8}$/)
  .transform(Number)
  .default(86400)
  .transform((value) => Math.min(value, 86400));
const Topic = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/)
  .optional();
export interface PushHeaders {
  "content-encoding"?: string | undefined;
  ttl?: string | undefined;
  urgency?: string | undefined;
  topic?: string | undefined;
}
export interface AlertPush {
  priority: 5 | 10;
  expiration: number;
  collapseId?: string;
  payload: Buffer;
}
export type PushProblem = "encoding" | "headers" | "size";

/**
 * The APNs request for one encrypted alert. The visible text is fixed here, never taken from
 * the sender: the phone's Notification Service Extension decrypts `ace.c` and replaces it.
 */
export function alertPush(
  headers: PushHeaders,
  body: Buffer,
  nowMs: number,
): AlertPush | PushProblem {
  if (headers["content-encoding"]?.toLowerCase() !== "aes128gcm") return "encoding";
  if (body.length > maxBody) return "size";
  if (body.length < minBody) return "headers";
  const urgency = Urgency.safeParse(headers.urgency?.toLowerCase());
  const ttl = Ttl.safeParse(headers.ttl);
  const topic = Topic.safeParse(headers.topic);
  if (!urgency.success || !ttl.success || !topic.success) return "headers";
  const quiet = urgency.data === "low" || urgency.data === "very-low";
  const payload = Buffer.from(
    JSON.stringify({
      aps: {
        alert: { title: "ace", body: "New activity" },
        "mutable-content": 1,
        "interruption-level": quiet ? "passive" : "active",
        ...(quiet ? {} : { sound: "default" }),
      },
      ace: { v: 1, c: body.toString("base64url") },
    }),
  );
  if (payload.length > 4096) return "size";
  return {
    priority: quiet ? 5 : 10,
    expiration: ttl.data === 0 ? 0 : Math.floor(nowMs / 1000) + ttl.data,
    ...(topic.data ? { collapseId: topic.data } : {}),
    payload,
  };
}
