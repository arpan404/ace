// zod/mini: the connection gate is on the first paint, and classic Zod is ~20 KB gzip more.
import * as z from "zod/mini";
import { type KeyValueStorage } from "@ace/ui-core";

/** The daemon listens on 127.0.0.1:4242 by default (ACE_PORT) and upgrades `/` to WebSocket. */
export const defaultDaemonUrl = "ws://127.0.0.1:4242/";

export const DaemonUrl = z.string().check(
  z.trim(),
  z.url("Enter a ws:// or wss:// address"),
  z.refine((value) => /^wss?:$/.test(new URL(value).protocol), "Use a ws:// or wss:// address"),
);
/** The local token (`~/.ace/daemon-token`) or a paired device token: 64 hex characters. */
export const DaemonToken = z
  .string()
  .check(z.trim(), z.regex(/^[0-9a-f]{64}$/i, "A daemon token is 64 hexadecimal characters"));
export const DaemonTarget = z.object({ url: DaemonUrl, token: DaemonToken });
export type DaemonTarget = z.infer<typeof DaemonTarget>;

const keys = { url: "ace.daemon.url", token: "ace.daemon.token" } as const;

/**
 * Where the token lives: in session storage by default (gone when the window closes), in
 * local storage only when the person asks to be remembered on this device.
 */
export interface ConnectionStores {
  local?: KeyValueStorage | undefined;
  session?: KeyValueStorage | undefined;
}

export function loadTarget(stores: ConnectionStores, fallbackUrl = defaultDaemonUrl) {
  const url = safeGet(stores.local, keys.url) ?? fallbackUrl;
  const token = safeGet(stores.session, keys.token) ?? safeGet(stores.local, keys.token);
  const parsed = DaemonTarget.safeParse({ url, token });
  return {
    url: DaemonUrl.safeParse(url).success ? url : fallbackUrl,
    target: parsed.success ? parsed.data : undefined,
    remembered: safeGet(stores.local, keys.token) !== undefined,
  };
}

export function saveTarget(stores: ConnectionStores, target: DaemonTarget, remember: boolean) {
  safeSet(stores.local, keys.url, target.url);
  safeRemove(stores.local, keys.token);
  safeRemove(stores.session, keys.token);
  safeSet(remember ? stores.local : stores.session, keys.token, target.token);
}

export function forgetToken(stores: ConnectionStores) {
  safeRemove(stores.local, keys.token);
  safeRemove(stores.session, keys.token);
}

/**
 * The daemon can open the app with `#token=<hex>` (and optionally `&daemon=<ws url>`). The
 * fragment never reaches a server; it is read once and removed from the address bar.
 */
export function targetFromFragment(hash: string, fallbackUrl: string): DaemonTarget | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const parsed = DaemonTarget.safeParse({
    url: params.get("daemon") ?? fallbackUrl,
    token: params.get("token") ?? "",
  });
  return parsed.success ? parsed.data : undefined;
}

function safeGet(storage: KeyValueStorage | undefined, key: string): string | undefined {
  try {
    return storage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function safeSet(storage: KeyValueStorage | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* Private mode: the target lasts for this session only. */
  }
}
function safeRemove(storage: KeyValueStorage | undefined, key: string) {
  try {
    storage?.removeItem?.(key);
  } catch {
    /* Nothing stored. */
  }
}
