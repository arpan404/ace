import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

/**
 * A synchronous full garbage collection, for test workers that measure retained heap. Bun has
 * its own `Bun.gc(true)`; on Node, V8's `--expose-gc` flag puts `gc` in new contexts.
 */
export function fullGc(): () => void {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  const bunGc = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
  if (typeof bunGc === "function") return () => void Reflect.apply(bunGc, bun, [true]);
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("V8 did not expose gc");
  return () => void Reflect.apply(gc, undefined, []);
}
