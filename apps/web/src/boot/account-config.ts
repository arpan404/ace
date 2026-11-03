import { readJson, type KeyValueStorage } from "@ace/ui-core";
import { AceAccountGrant } from "@ace/protocol/ace-account";
import { z } from "zod";

/*
 * Where this build finds ace's account backend and hosted relay (docs/relay/accounts.md). The
 * Worker serves both on one domain, so the relay is the account origin as `wss://` unless
 * `VITE_ACE_HOSTED_RELAY_URL` names another.
 */

/** The account backend's origin, or undefined in a build without ace accounts. */
export function accountOrigin(env: ImportMetaEnv = import.meta.env): string | undefined {
  return env.VITE_ACE_ACCOUNT_URL || undefined;
}

/** ace's hosted relay as a WebSocket address, or undefined without an account backend. */
export function hostedRelayUrl(env: ImportMetaEnv = import.meta.env): string | undefined {
  if (env.VITE_ACE_HOSTED_RELAY_URL) return env.VITE_ACE_HOSTED_RELAY_URL;
  const origin = accountOrigin(env);
  if (!origin) return undefined;
  const url = new URL(origin);
  return `${url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}`;
}

/** Where a window keeps its copy of the ace session for `origin`. */
export function accountSessionKey(origin: string): string {
  return `ace.account.session:${origin}`;
}

/** The ace session this window holds for `origin`, if any. */
export function windowAccountSession(storage: KeyValueStorage, origin: string) {
  return readJson(storage, accountSessionKey(origin), AceAccountGrant.nullable(), null);
}

const deviceKey = "ace.account.deviceId";
const DeviceIdShape = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

/** This browser's device id on the account: the subject of its device grants, kept for good. */
export function accountDeviceId(storage: KeyValueStorage, id: () => string): string {
  const saved = DeviceIdShape.safeParse(storage.getItem(deviceKey));
  if (saved.success) return saved.data;
  const next = id();
  storage.setItem(deviceKey, next);
  return next;
}
