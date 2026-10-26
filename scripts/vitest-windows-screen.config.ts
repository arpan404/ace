import { defineConfig } from "vitest/config";
import native from "./vitest-windows-native.config.ts";

// Run after Cargo has built the native helper. Capture, UIA and foreground input
// use only owned fixture windows on the disposable CI desktop.
export default defineConfig({
  test: {
    ...native.test,
    include: [
      "packages/screen/src/windows-native-helper.process.test.ts",
      "packages/screen/src/windows-owned-capture.process.test.ts",
      "packages/screen/src/windows-owned-input.process.test.ts",
    ],
    maxWorkers: 1,
  },
});
