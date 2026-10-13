import type { Plugin } from "esbuild";

/**
 * Native packages only the daemon ships. The daemon bundle keeps them external and stages
 * them (with their platform binaries) under `dist/daemon/node_modules`; app.asar has neither,
 * so if one is bundled into the Electron main process it throws when it loads.
 */
const daemonOnlyNatives = ["koffi", "node-pty"];
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
