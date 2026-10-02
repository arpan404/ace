import { open } from "node:fs/promises";
import {
  createApnsTransport,
  createWebPushTransport,
  type NotificationChannels,
} from "@ace/notify";

/** Startup-only key reads. Provider CLI credentials are never involved. */
const noop = () => {};
async function signingKey(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4097);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset > 4096) throw new Error("Notification signing key exceeds 4096 bytes");
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function loadNotificationChannels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ channels: Omit<NotificationChannels, "websocket">; close(): void }> {
  const channels: Omit<NotificationChannels, "websocket"> = {};
  let close = noop;
  if (env.ACE_APNS_KEY_FILE) {
    const apns = createApnsTransport(
      {
        teamId: env.ACE_APNS_TEAM_ID,
        keyId: env.ACE_APNS_KEY_ID,
        topic: env.ACE_APNS_TOPIC,
        privateKey: await signingKey(env.ACE_APNS_KEY_FILE),
        ...(env.ACE_APNS_ENDPOINT ? { endpoint: env.ACE_APNS_ENDPOINT } : {}),
      },
      Date.now,
    );
    channels.apns = apns;
    close = apns.close;
  }
  try {
    if (env.ACE_VAPID_KEY_FILE)
      channels.webpush = createWebPushTransport(
        {
          privateKey: await signingKey(env.ACE_VAPID_KEY_FILE),
          subject: env.ACE_VAPID_SUBJECT,
          allowedOrigins: JSON.parse(env.ACE_WEB_PUSH_ORIGINS ?? "[]"),
        },
        Date.now,
      );
  } catch (error) {
    close();
    throw error;
  }
  return { channels, close };
}
