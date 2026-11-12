import { readJson, type KeyValueStorage } from "@ace/ui-core";
import {
  ACE_APP_SIGN_IN_RETURN,
  ACE_FORMER_HOSTED_ACCOUNT_ORIGINS,
  ACE_HOSTED_ACCOUNT_ORIGIN,
  ACE_WEB_SIGN_IN_PATH,
  AceAccountGrant,
  HostedAddress,
} from "@ace/protocol/ace-account";

/*
 * Where this build finds ace's account backend and hosted relay (docs/relay/accounts.md). The
 * Worker serves both on one domain, so the relay is the account origin as `wss://` unless
 * `VITE_ACE_HOSTED_RELAY_URL` names another.
 */

/**
 * The account backend's origin, or undefined in a build without ace accounts. A release build
 * uses ace's own unless `VITE_ACE_ACCOUNT_URL` names another; set empty, it turns accounts off.
 * Development and tests have none unless they set it.
 */
export function accountOrigin(env: ImportMetaEnv = import.meta.env): string | undefined {
  if (env.VITE_ACE_ACCOUNT_URL !== undefined) return env.VITE_ACE_ACCOUNT_URL || undefined;
  return env.PROD ? ACE_HOSTED_ACCOUNT_ORIGIN : undefined;
}

/** ace's hosted relay as a WebSocket address, or undefined without an account backend. */
export function hostedRelayUrl(env: ImportMetaEnv = import.meta.env): string | undefined {
  if (env.VITE_ACE_HOSTED_RELAY_URL) return env.VITE_ACE_HOSTED_RELAY_URL;
  const origin = accountOrigin(env);
  if (!origin) return undefined;
  const url = new URL(origin);
  return `${url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}`;
}

/**
 * Where the browser goes when sign-in ends (ADR 0100): the desktop app's `ace://` link, or this
 * web app's landing page on its own origin. Undefined where neither applies.
 */
export function signInReturnTo(page: { desktop: boolean; origin: string }): string | undefined {
  if (page.desktop) return ACE_APP_SIGN_IN_RETURN;
  return /^https?:\/\/[^/]+$/.test(page.origin)
    ? `${page.origin}${ACE_WEB_SIGN_IN_PATH}`
    : undefined;
}

/** Where a window keeps its copy of the ace session for `origin`. */
export function accountSessionKey(origin: string): string {
  return `ace.account.session:${origin}`;
}

/** Whether `machineOrigin`, saved with a machine, names the account backend at `origin`. */
export function sameAccountOrigin(origin: string, machineOrigin: string): boolean {
  return HostedAddress.parse(origin) === HostedAddress.parse(machineOrigin);
}

/**
 * Moves a session this window kept under a former address of ace's backend to `origin`'s key,
 * so the window stays signed in across the move. A session already under `origin` stays.
 */
function moveFormerWindowSession(storage: KeyValueStorage, origin: string): void {
  const key = accountSessionKey(origin);
  if (HostedAddress.parse(origin) !== origin || storage.getItem(key) !== null) return;
  for (const former of ACE_FORMER_HOSTED_ACCOUNT_ORIGINS) {
    if (HostedAddress.parse(former) !== origin) continue;
    const value = storage.getItem(accountSessionKey(former));
    if (value === null) continue;
    storage.setItem(key, value);
    storage.removeItem?.(accountSessionKey(former));
    return;
  }
}

/** The ace session this window holds for `origin`, if any. */
export function windowAccountSession(storage: KeyValueStorage, origin: string) {
  moveFormerWindowSession(storage, origin);
  return readJson(storage, accountSessionKey(origin), AceAccountGrant.nullable(), null);
}
