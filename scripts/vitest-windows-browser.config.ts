import { defineConfig } from "vitest/config";
import native from "./vitest-windows-native.config.ts";

// Every browser workflow's tests on native Windows: ace's own Chrome, Use my Chrome's extension
// and native host, browser annotation and dev-server preview. Runs after the Windows Chrome is
// prepared (`packages/browser/scripts/prepare-windows-test.ts`).
export default defineConfig({
  test: {
    ...native.test,
    include: [
      "packages/browser/src/**/*.test.ts",
      "packages/browser-extension/src/**/*.test.ts",
      "packages/browser-annotate/src/**/*.test.ts",
      "packages/preview/src/**/*.test.ts",
    ],
    testNamePattern: undefined,
    maxWorkers: 2,
  },
});
