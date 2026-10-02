import { readFile } from "node:fs/promises";
import {
  createApnsTransport,
  createWebPushTransport,
  type NotificationChannels,
} from "@ace/notify";

/** Startup-only key reads. Provider CLI credentials are never involved. */
const noop = () => {};

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
        privateKey: await readFile(env.ACE_APNS_KEY_FILE, "utf8"),
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
          privateKey: await readFile(env.ACE_VAPID_KEY_FILE, "utf8"),
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
