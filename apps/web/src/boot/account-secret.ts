import { z } from "zod";

/** Native secure storage is absent in the browser, which keeps only a window session. */
export function accountSecret(scope: object = globalThis) {
  const ace: unknown = Reflect.get(scope, "ace");
  if (!ace || typeof ace !== "object") return undefined;
  const account: unknown = Reflect.get(ace, "account");
  if (!account || typeof account !== "object") return undefined;
  const read: unknown = Reflect.get(account, "read");
  const write: unknown = Reflect.get(account, "write");
  if (typeof read !== "function" || typeof write !== "function") return undefined;
  return {
    async read(origin: string) {
      const result: unknown = await read(origin);
      return z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .nullable()
        .parse(result);
    },
    async write(origin: string, token: string | null) {
      await write(origin, token);
    },
  };
}
