import { dirname, join } from "node:path";
import type { Plugin } from "esbuild";

/**
 * zod's classic API re-exports every locale as `z.locales` (about 360 KB, a quarter of the
 * unminified main bundle and half the preload). Nothing in ace calls `z.config(z.locales.x())`,
 * and zod registers English by importing `locales/en.js` directly, so the locales index is
 * replaced by one that exports English alone.
 */
export const zodEnglishOnly: Plugin = {
  name: "zod-english-only",
  setup(build) {
    build.onResolve({ filter: /^\.\.\/locales\/index\.c?js$/ }, (args) => {
      if (!/[\\/]zod[\\/]v4[\\/](classic|core)[\\/]/.test(args.importer)) return undefined;
      const extension = args.path.endsWith(".cjs") ? "cjs" : "js";
      return {
        path: join(dirname(args.importer), "..", "locales", `en.${extension}`),
        namespace: "zod-english-only",
      };
    });
    build.onLoad({ filter: /.*/, namespace: "zod-english-only" }, (args) => ({
      contents: `export { default as en } from ${JSON.stringify(args.path)};`,
      resolveDir: dirname(args.path),
      loader: "js",
    }));
  },
};
