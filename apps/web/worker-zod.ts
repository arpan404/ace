import type { Plugin } from "vite";
import { MagicString } from "magic-string";

/**
 * These envelopes use the functional API shared by classic and mini. The page needs mini on
 * first paint; the worker already needs classic for protocol schemas, so use its constructors
 * there too rather than keeping a second set of schema classes and factory functions.
 */
export function workerZod(): Plugin {
  return {
    name: "ace:worker-zod",
    transform(code, id) {
      if (
        !/(?:\/packages\/client-worker\/src\/wire|\/apps\/web\/src\/boot\/(?:worker-target|connection-settings))\.ts$/.test(
          id,
        )
      )
        return null;
      const out = new MagicString(code).replaceAll('"zod/mini"', '"zod"');
      return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) };
    },
  };
}
