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
  noExternal: (id) => id.startsWith("@ace/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
