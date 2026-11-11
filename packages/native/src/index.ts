import { native } from "./binding.ts";

/**
 * The offset just past each `\n` in `bytes`, in order. A final line without a newline has no
 * entry. Buffers of 4 GiB or more throw. The bytes are read in place, not copied.
 */
export function lineEnds(bytes: Uint8Array): Uint32Array {
  return native().lineEnds(bytes);
}
