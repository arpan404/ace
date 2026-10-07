import type { CursorAdapterOptions } from "@ace/adapter-cursor";

/** Installed metadata at an offline SDK boundary; never resolves the user's installation. */
export const cursorSdkDiscovery: NonNullable<CursorAdapterOptions["discovery"]> = {
  platform: "linux",
  arch: "x64",
  nodeVersion: "24.0.0",
  resolve: (id) => (id === "@cursor/sdk" ? "/sdk/index.js" : "/helper/package.json"),
  read: async (path) =>
    path === "/sdk/package.json"
      ? '{"name":"@cursor/sdk","version":"1.0.35"}'
      : '{"name":"@cursor/sdk-linux-x64","version":"1.0.35"}',
  executable: async () => {},
};
