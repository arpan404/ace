import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.ACE_SERVER_SOURCEMAP?.trim().toLowerCase();
const sourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap,
  clean: true,
  deps: {
    alwaysBundle: (id) => id.startsWith("@ace/"),
    neverBundle: ["@github/copilot-sdk"],
    onlyBundle: false,
  },
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
