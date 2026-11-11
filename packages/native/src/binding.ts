import { createRequire } from "node:module";
import { z } from "zod";

/**
 * Loads ace's Rust add-on (ADR 0125) on first use. Development and tests load
 * `dist/ace-native.node`, built by `bun install`; the release bundle rewrites the path to the
 * copy beside it.
 *
 * The surface is checked once at load: the version must match exactly, so a stale build
 * fails here with the fix in the message, and every function must be present. Arguments and
 * results are not wrapped in per-call schemas: the add-on is ace's own code built from this
 * checkout, and wrapping each call would cost more than many of the calls themselves.
 */
export const SURFACE_VERSION = 1;

// A function's signature can't be checked at runtime; its presence can. The declared
// signatures are the add-on's contract, which the parity tests hold it to.
const fn = <T>() => z.custom<T>((value) => typeof value === "function");
const Surface = z.object({
  SURFACE_VERSION: z.number().int(),
  lineEnds: fn<(bytes: Uint8Array) => Uint32Array>(),
});
export type NativeBinding = Omit<z.infer<typeof Surface>, "SURFACE_VERSION">;

const require = createRequire(import.meta.url);
let loaded: NativeBinding | undefined;

export function native(): NativeBinding {
  if (loaded) return loaded;
  const surface = Surface.parse(require("../dist/ace-native.node"));
  if (surface.SURFACE_VERSION !== SURFACE_VERSION)
    throw new Error(
      `ace's Rust add-on is surface ${surface.SURFACE_VERSION}, this checkout needs ` +
        `${SURFACE_VERSION}; run bun run --filter @ace/native build:native`,
    );
  loaded = surface;
  return loaded;
}
