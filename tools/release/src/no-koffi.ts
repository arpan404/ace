import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";

/**
 * The standalone daemon ships no koffi: it runs on Bun and binds native code with bun:ffi.
 * Only the desktop app's main process loads koffi (`@ace/provider-kit/koffi`), and provider-kit
 * code the daemon shares still carries that lazy path, so the daemon's bundles swap the loader
 * for one that throws. Anything else that reaches koffi fails the release build here instead of
 * failing on a user's machine.
 */
export const daemonWithoutKoffi: Plugin = {
  name: "daemon-without-koffi",
  setup(build) {
    build.onResolve({ filter: /^koffi(?:\/.*)?$/ }, (args) => ({
      errors: [
        {
          text: `${args.path} is not shipped with the daemon (imported by ${args.importer}); bind native code with bun:ffi (@ace/provider-kit/bun-ffi).`,
        },
      ],
    }));
    build.onLoad({ filter: /[\\/]provider-kit[\\/]src[\\/]koffi\.ts$/ }, () => ({
      loader: "ts",
      contents:
        'export function loadKoffi(): never { throw new Error("The daemon binds native code with bun:ffi; this FFI addon ships only with the desktop app"); }',
    }));
  },
};

/** A string literal naming koffi or one of its files, as `require("koffi")` would carry. */
const koffiSpecifier = /(["'`])koffi(?:\/[^"'`\n]*)?\1/;

/** The first koffi specifier in a script, with some context, if it has one. */
export function koffiReference(source: string): string | undefined {
  const found = koffiSpecifier.exec(source);
  return found ? source.slice(Math.max(0, found.index - 40), found.index + 30) : undefined;
}

/** Refuses daemon scripts that would load koffi at runtime, naming the script. */
export async function assertNoKoffi(paths: Iterable<string>): Promise<void> {
  for (const path of paths) {
    if (!/\.m?js$/.test(path)) continue;
    const found = koffiReference(await readFile(path, "utf8"));
    if (found)
      throw new Error(
        `${path} loads koffi (${JSON.stringify(found)}), which the daemon does not ship. Bind native code with bun:ffi instead.`,
      );
  }
}
