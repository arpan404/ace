import { createPublicKey } from "node:crypto";
import { open } from "node:fs/promises";
import { assertTestHomeIsolation } from "@ace/provider-kit/test-isolation";
import {
  createApnsTransport,
  createPushGatewayTransport,
  createWebPushTransport,
  type NotificationChannels,
  type PushGatewayTarget,
} from "@ace/notify";
import { SettingsValues } from "@ace/protocol";
import { defaults } from "@ace/settings/defaults";
import type { SettingsService } from "@ace/settings";
import { loadHostId, loadPushKey } from "./local-files.ts";

/** Startup-only key reads. Provider CLI credentials are never involved. */
const noop = () => {};
async function signingKey(path: string): Promise<string> {
  assertTestHomeIsolation(path);
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

/** The push switch and gateway origin, read live so a settings change applies at once. */
export async function pushTarget(
  settings: Pick<SettingsService, "get"> | undefined,
): Promise<PushGatewayTarget> {
  const fallback = {
    enabled: defaults["notifications.remotePush"],
    origin: defaults["notifications.pushGatewayUrl"],
  };
  if (!settings) return fallback;
  try {
    const [enabled, origin] = await Promise.all([
      settings.get("notifications.remotePush"),
      settings.get("notifications.pushGatewayUrl"),
    ]);
    const parsedEnabled = SettingsValues.shape["notifications.remotePush"].safeParse(enabled.value);
    const parsedOrigin = SettingsValues.shape["notifications.pushGatewayUrl"].safeParse(
      origin.value,
    );
    return {
      enabled: parsedEnabled.success ? parsedEnabled.data : fallback.enabled,
      origin: parsedOrigin.success ? parsedOrigin.data : fallback.origin,
    };
  } catch {
    // An unreadable value keeps the default, as settings keep the last good file.
    return fallback;
  }
}

export async function loadNotificationChannels(options: {
  env?: NodeJS.ProcessEnv;
  /** The daemon's data directory: holds its push identity key (ADR 0106). */
  dataDir: string;
  /** Live settings for the per-machine push switch; defaults apply without them. */
  settings?: Pick<SettingsService, "get"> | undefined;
}): Promise<{
  channels: Omit<NotificationChannels, "websocket">;
  publicKey?: string;
  close(): void;
}> {
  const { env = process.env, dataDir, settings } = options;
  const channels: Omit<NotificationChannels, "websocket"> = {};
  let close = noop;
  let publicKey: string | undefined;
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
    if (env.ACE_VAPID_KEY_FILE) {
      const privateKey = await signingKey(env.ACE_VAPID_KEY_FILE);
      const jwk = createPublicKey(privateKey).export({ format: "jwk" });
      if (!jwk.x || !jwk.y) throw new Error("Invalid Web Push signing key");
      publicKey = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x, "base64url"),
        Buffer.from(jwk.y, "base64url"),
      ]).toString("base64url");
      channels.webpush = createWebPushTransport(
        {
          privateKey,
          subject: env.ACE_VAPID_SUBJECT,
          allowedOrigins: JSON.parse(env.ACE_WEB_PUSH_ORIGINS ?? "[]"),
        },
        Date.now,
      );
    }
    // Phones with a push address wake through ace's push gateway (ADR 0106). The daemon's
    // own key is its identity there; every alert leaves encrypted to the phone's key.
    channels.push = createPushGatewayTransport(
      {
        privateKey: loadPushKey(dataDir),
        hostId: loadHostId(dataDir),
        target: () => pushTarget(settings),
      },
      Date.now,
    );
  } catch (error) {
    close();
    throw error;
  }
  return { channels, close, ...(publicKey ? { publicKey } : {}) };
}
