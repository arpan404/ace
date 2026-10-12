import { readJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";

/** Two minutes tolerates background-tab timer throttling; renew every ten seconds. */
export const uploadLeaseMs = 120_000;
const heartbeatMs = 10_000;
const prefix = "ace.sends.upload-owner\0";
const Expiry = z.number().check(z.int(), z.gte(0), z.lte(Number.MAX_SAFE_INTEGER));

export interface UploadLeaseClock {
  now(): number;
  setTimer(callback: () => void, delay: number): () => void;
}

/** Browser timer I/O with the app's injected wall clock. */
export function uploadLeaseClock(now: () => number): UploadLeaseClock {
  return {
    now,
    setTimer(callback, delay) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  };
}
export const browserUploadLeaseClock = uploadLeaseClock(() => Date.now());

export function uploadOwnerAlive(
  storage: KeyValueStorage | undefined,
  owner: string,
  now: number,
): boolean {
  return (readJson(storage, prefix + owner, Expiry, 0) ?? 0) > now;
}

/** One small heartbeat per uploading page, independent of its mounted route. */
export function maintainUploadLease(
  storage: KeyValueStorage | undefined,
  owner: string,
  clock: UploadLeaseClock,
): { stop(): void; abandon(): void } | undefined {
  if (!storage || storage.durable === false) return;
  const renew = () => {
    const expiry = Expiry.safeParse(clock.now() + uploadLeaseMs);
    if (!expiry.success) return false;
    try {
      storage.setItem(prefix + owner, JSON.stringify(expiry.data));
      return true;
    } catch {
      return false;
    }
  };
  if (!renew()) return;
  let cancel: (() => void) | undefined;
  let running = true;
  const beat = () => {
    if (!running) return;
    renew();
    cancel = clock.setTimer(beat, heartbeatMs);
  };
  cancel = clock.setTimer(beat, heartbeatMs);
  // Renew immediately on wake as well as during background uploads.
  const wake = () => {
    if (running) renew();
  };
  if (typeof addEventListener === "function") {
    addEventListener("pageshow", wake);
  }
  if (typeof document === "object") document.addEventListener("visibilitychange", wake);
  const abandon = () => {
    running = false;
    cancel?.();
    if (typeof removeEventListener === "function") {
      removeEventListener("pageshow", wake);
    }
    if (typeof document === "object") document.removeEventListener("visibilitychange", wake);
  };
  return {
    abandon,
    stop() {
      abandon();
      try {
        storage.removeItem?.(prefix + owner);
      } catch {
        /* The unused lease can expire. */
      }
    },
  };
}
