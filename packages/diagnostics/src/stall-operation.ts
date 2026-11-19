/** Bytes of one operation name; longer names are cut. */
const NAME_BYTES = 252;
const HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT;

export interface StallOperation {
  /** Shared with the watchdog thread: a length, then the UTF-8 name. */
  readonly buffer: SharedArrayBuffer;
  /** Runs `work` with `name` as the current operation, and restores the previous one after. */
  run<T>(name: string, work: () => T): T;
  /** The same as `run`, for a callback something else calls later (a listener, a handler). */
  wrap<A extends unknown[], R>(name: string, work: (...args: A) => R): (...args: A) => R;
}

/**
 * Names the main thread's current operation where a watchdog thread can read it during a
 * stall. Marking covers synchronous work only: an async function is marked until its first
 * `await`, which is the part that can block the thread. Cost per call: one short copy.
 */
export function createStallOperation(): StallOperation {
  const buffer = new SharedArrayBuffer(HEADER_BYTES + NAME_BYTES);
  const length = new Int32Array(buffer, 0, 1);
  const bytes = new Uint8Array(buffer, HEADER_BYTES);
  const encoder = new TextEncoder();
  let current = "";
  const set = (name: string) => {
    current = name;
    // A length of zero first: a reader never sees a new length over the old bytes.
    Atomics.store(length, 0, 0);
    const { written } = encoder.encodeInto(name, bytes);
    Atomics.store(length, 0, written);
  };
  const run = <T>(name: string, work: () => T): T => {
    const previous = current;
    set(name);
    try {
      return work();
    } finally {
      set(previous);
    }
  };
  return {
    buffer,
    run,
    wrap:
      (name, work) =>
      (...args) =>
        run(name, () => work(...args)),
  };
}

/** The operation the main thread named last, or undefined when none is running. */
export function readStallOperation(buffer: SharedArrayBuffer): string | undefined {
  const written = Atomics.load(new Int32Array(buffer, 0, 1), 0);
  if (written <= 0) return undefined;
  const bytes = new Uint8Array(buffer, HEADER_BYTES, Math.min(written, NAME_BYTES)).slice();
  // `fatal: false`: a name cut inside a character still reads, with a replacement mark.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes) || undefined;
}
