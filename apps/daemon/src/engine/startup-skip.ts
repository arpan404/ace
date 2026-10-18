import { incompatibleData } from "@ace/provider-kit/incompatible-data";
import { isStoreRetry } from "../store-busy.ts";

/**
 * Whether startup may skip one thread whose stored state failed, and recover the rest.
 * A busy store is retried by the caller, and data another ace build wrote is refused for the
 * whole database: skipping every thread would hide the person's history behind an empty list.
 */
export function skippableAtStartup(error: unknown): boolean {
  return !isStoreRetry(error) && incompatibleData(error) === undefined;
}
