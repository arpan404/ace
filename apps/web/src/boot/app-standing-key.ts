import { z } from "zod";

/*
 * The desktop app's standing key (ADR 0190, amendment 1), kept by its main process in the OS
 * keychain: this window asks it for the key's public half, to register with its daemon once the
 * window proved the owner's grant, and for its signature over each new socket's challenge.
 * Absent in a browser, which proves with its session's grant on every socket.
 */

const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{87}$/);
const Signed = z.object({ key: PublicKey, proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });

export interface AppStandingKey {
  /** The key's public half for `account` at `origin`; main makes one if it has none. */
  key(origin: string, account: string): Promise<string>;
  /** Main's signature over `text`, or null when it keeps no key for `account` at `origin`. */
  sign(
    origin: string,
    account: string,
    text: string,
  ): Promise<{ key: string; proof: string } | null>;
}

export function appStandingKey(scope: object = globalThis): AppStandingKey | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (!ace || typeof ace !== "object") return undefined;
  const standing: unknown = Reflect.get(ace, "standing");
  if (!standing || typeof standing !== "object") return undefined;
  const key: unknown = Reflect.get(standing, "key");
  const sign: unknown = Reflect.get(standing, "sign");
  if (typeof key !== "function" || typeof sign !== "function") return undefined;
  return {
    key: async (origin, account) => PublicKey.parse(await key(origin, account)),
    sign: async (origin, account, text) =>
      Signed.nullable().parse(await sign(origin, account, text)),
  };
}
