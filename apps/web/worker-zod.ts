import type { Plugin } from "vite";
import { MagicString } from "magic-string";

/**
 * These envelopes use the functional API shared by classic and mini. The worker already
 * needs classic for protocol schemas, so share its constructors instead of keeping a second
 * set of schema classes and factory functions.
 */
export function workerZod(): Plugin {
  return {
    name: "ace:worker-zod",
    transform(code, id) {
      if (
        !/(?:\/packages\/client-worker\/src\/wire|\/apps\/web\/src\/boot\/(?:worker-target|machine-target|connection-settings))\.ts$/.test(
          id,
        )
      )
        return null;
      const out = new MagicString(code).replaceAll('"zod/mini"', '"zod"');
      return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) };
    },
  };
}

/** The page now loads classic protocol schemas eagerly too; share their functional factories. */
export function pageZod(): Plugin {
  return {
    name: "ace:page-zod",
    transform(code, id) {
      if (
        !/(?:\/apps\/web\/src\/[^?]*\.[tj]sx?|\/packages\/client-worker\/src\/wire\.ts|\/packages\/ui-core\/src\/first-launch\.ts)$/.test(
          id,
        ) ||
        !code.includes('"zod/mini"')
      )
        return null;
      const out = new MagicString(code).replaceAll('"zod/mini"', '"zod"');
      return { code: out.toString(), map: out.generateMap({ hires: true, source: id }) };
    },
  };
}
