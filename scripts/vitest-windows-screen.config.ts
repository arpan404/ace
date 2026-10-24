import { defineConfig } from "vitest/config";
import native from "./vitest-windows-native.config.ts";

// Run after Cargo has built the native helper. These requests inspect the
// desktop and reject unavailable targets without capturing or injecting input.
export default defineConfig({
  test: {
    ...native.test,
    include: ["packages/screen/src/windows-native-helper.process.test.ts"],
  },
});
