import type { Plugin } from "esbuild";

/**
 * Native code a main-process bundle must not import: node-pty (the app has none), `bun:ffi`,
 * which exists only in the Bun runtime the daemon runs on, and koffi. The app ships koffi beside
 * app.asar (scripts/koffi.ts), but bundling it would cut it off from its prebuilt binary, so main
 * reaches it only through `@ace/provider-kit/koffi`'s lazy require, and `bun:ffi` only through a
 * lazy require behind a Bun check.
 */
const daemonOnlyNatives = ["koffi", "node-pty", "bun:ffi"];
const nativeImport = new RegExp(
  `^(?:${daemonOnlyNatives.join("|")})(?:/.*)?$|\\.node$`.replaceAll("-", "\\-"),
);

/**
 * Fails a bundle that imports a native module, naming the importer, so the mistake shows up
 * at build time instead of as a crash when the packaged app launches.
 */
export const noNativeModules: Plugin = {
  name: "no-native-modules",
  setup(build) {
    build.onResolve({ filter: nativeImport }, (args) => ({
      errors: [
        {
          text: `${args.path} is native code, which this bundle cannot load (imported by ${args.importer}). Import a module that does not need it, or load it only in the daemon.`,
        },
      ],
    }));
  },
};
