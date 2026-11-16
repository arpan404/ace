import type { Env } from "./env.ts";
import type { KeySource } from "./grant-keys.ts";

/** What a handler gets besides the request: bindings, and what the shell injects. */
export interface Context {
  env: Env;
  /** The request's time, from the shell's clock. */
  now: number;
  /** Work that finishes after the response, such as a download count. */
  waitUntil(promise: Promise<unknown>): void;
  /** The account backend's grant keys. */
  grantKeys: KeySource;
  /** A fresh publisher id. */
  newId(): string;
}

/** An archive's place in R2. */
export const objectKey = (hash: string) => `objects/${hash}`;
