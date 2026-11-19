import type { Plugin } from "esbuild";

/**
 * Dependencies whose `main` is a UMD build that requires its own files at run time. A bundle
 * can't serve those files, so the packaged app would crash on its first import ("Cannot find
 * module './impl/format'"). Their ESM builds bundle whole.
 */
const esmEntries: Record<string, string> = {
  "jsonc-parser": "jsonc-parser/lib/esm/main.js",
};

/** Resolves each listed package to its ESM build, from the importing file's own directory. */
export const preferEsmBuilds: Plugin = {
  name: "prefer-esm-builds",
  setup(build) {
    const names = Object.keys(esmEntries).map((name) => name.replaceAll("-", "\\-"));
    build.onResolve({ filter: new RegExp(`^(?:${names.join("|")})$`) }, (args) => {
      const entry = esmEntries[args.path];
      if (!entry || args.pluginData === preferEsmBuilds) return undefined;
      return build.resolve(entry, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: preferEsmBuilds,
      });
    });
  },
};
