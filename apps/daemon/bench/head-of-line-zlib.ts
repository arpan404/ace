/**
 * `node:zlib` as the relay channel sees it in head-of-line.ts's bench daemon: the same
 * functions, with each synchronous deflate timed into the probe. Bench code only.
 */
import * as zlib from "node:zlib";
import { recordDeflate } from "./head-of-line-probe.ts";

export function deflateRawSync(input: Uint8Array, options?: zlib.ZlibOptions): Buffer {
  const start = performance.now();
  try {
    return zlib.deflateRawSync(input, options);
  } finally {
    recordDeflate(input.length, performance.now() - start);
  }
}
export const { deflateRaw, inflateRawSync } = zlib;
