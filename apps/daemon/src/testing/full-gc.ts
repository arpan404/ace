import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { z } from "zod";

const BunGc = z.object({ gc: z.function() });

/**
 * A synchronous full garbage collection, for test workers that measure retained heap. Bun has
 * its own `Bun.gc(true)`; on Node, V8's `--expose-gc` flag puts `gc` in new contexts.
 */
export function fullGc(): () => void {
  const bun = BunGc.safeParse(Reflect.get(globalThis, "Bun"));
  if (bun.success) {
    const gc = bun.data.gc;
    return () => void gc(true);
  }
  setFlagsFromString("--expose-gc");
  const gc = z.function().parse(runInNewContext("gc"));
  return () => void gc();
}
