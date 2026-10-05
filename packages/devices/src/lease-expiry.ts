import type { ControllerLease } from "./lease.ts";
/** A held pointer must be released even when no further command reads the expired lease. */
export function watchDeviceLease(
  lease: ControllerLease,
  runtime: { now(): number; after(ms: number, run: () => void): () => void },
  expired: () => void,
): () => void {
  let active = true;
  let cancel: (() => void) | undefined;
  const check = () => {
    if (!active) return;
    const status = lease.status();
    if (status.leaseExpiresAt === undefined) {
      active = false;
      expired();
      return;
    }
    cancel = runtime.after(Math.max(0, status.leaseExpiresAt - runtime.now()), check);
  };
  const initial = lease.status();
  if (initial.leaseExpiresAt === undefined) active = false;
  else check();
  return () => {
    active = false;
    cancel?.();
  };
}
