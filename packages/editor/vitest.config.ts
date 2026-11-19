import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The package runs on its own so the Wasm build is its only prerequisite: no repo-wide setup
// files, no jsdom. Tests load `pkg/` from disk, which works on both Node and Bun.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "editor",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
