import type { KeptValue } from "./kept-value.ts";

/*
 * Reading a kept value safely: a failed read is retried with a bounded backoff on the host's
 * timers, and owners save nothing until a read succeeds. Pure apart from the injected timers.
 */

/** Timers from the host (`hostScheduler`), or the test's. */
export interface Timers {
  set(delay: number, callback: () => void): () => void;
}

/** Wait after the `failures`th failure in a row: 1 s, doubling, at most a minute. */
export const retryDelay = (failures: number) => Math.min(60_000, 1000 * 2 ** (failures - 1));

export interface KeptRead {
  /** Settles after the first try, read or not. */
  tried: Promise<void>;
  /** Settles with what was kept once a read succeeds. */
  read: Promise<unknown>;
}

/**
 * Read `value` until a read succeeds, waiting `retryDelay` between failures. `failing` hears
 * true after each failure and false once it reads, so the owner can say why nothing is saved.
 */
export function readKept(
  value: KeptValue,
  timers: Timers,
  failing: (failed: boolean) => void,
): KeptRead {
  const tried = Promise.withResolvers<void>();
  const read = Promise.withResolvers<unknown>();
  let failures = 0;
  const attempt = () => {
    value.load().then(
      (kept) => {
        if (failures) failing(false);
        read.resolve(kept);
        tried.resolve();
      },
      () => {
        failures++;
        failing(true);
        tried.resolve();
        timers.set(retryDelay(failures), attempt);
      },
    );
  };
  attempt();
  return { tried: tried.promise, read: read.promise };
}

/** UTF-8 bytes of `text`, as the host counts its cap. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xe000 ? 2 : 3;
  }
  return bytes;
}
