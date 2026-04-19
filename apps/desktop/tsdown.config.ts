import { defineConfig } from "tsdown";

const sourcemapEnv = process.env.ACE_DESKTOP_SOURCEMAP?.trim().toLowerCase();
const sourcemap = sourcemapEnv === "1" || sourcemapEnv === "true";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap,
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: (id) => id.startsWith("@ace/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
]);
