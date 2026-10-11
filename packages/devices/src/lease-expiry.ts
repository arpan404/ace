import type { ControllerLease } from "./lease.ts";
function noop() {}
/** A held pointer must be released even when no further command reads the expired lease. */
export function watchDeviceLease(
  lease: ControllerLease,
  runtime: { now(): number; after(ms: number, run: () => void): () => void },
  expired: () => void,
  renewed: () => void = noop,
): () => void {
  let active = true;
  let cancel: (() => void) | undefined;
  let deadline = lease.status().leaseExpiresAt;
  const check = () => {
    if (!active) return;
    const status = lease.status();
    if (status.leaseExpiresAt === undefined) {
      active = false;
      expired();
      return;
    }
    if (deadline !== status.leaseExpiresAt) {
      deadline = status.leaseExpiresAt;
      renewed();
    }
    cancel = runtime.after(
      Math.min(5000, Math.max(0, status.leaseExpiresAt - runtime.now())),
      check,
    );
  };
  const initial = lease.status();
  if (initial.leaseExpiresAt === undefined) active = false;
  else check();
  return () => {
    active = false;
    cancel?.();
  };
}
