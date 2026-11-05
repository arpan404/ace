import type { Plugin } from "esbuild";

/**
 * Native code the Electron main process cannot load: koffi and node-pty (app.asar has neither)
 * and `bun:ffi`, which exists only in the Bun runtime the daemon runs on. Code bundled into the
 * main process reaches `bun:ffi` only through a lazy require behind a Bun check.
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
