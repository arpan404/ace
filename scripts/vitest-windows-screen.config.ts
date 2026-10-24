import { defineConfig } from "vitest/config";
import native from "./vitest-windows-native.config.ts";

// Run after Cargo has built the native helper. The GUI fixture owns its window;
// no test injects pointer or keyboard input into the desktop.
export default defineConfig({
  test: {
    ...native.test,
    include: [
      "packages/screen/src/windows-native-helper.process.test.ts",
      "packages/screen/src/windows-owned-capture.process.test.ts",
    ],
    maxWorkers: 1,
  },
});
