import { defineConfig } from "vitest/config";
import native from "./vitest-windows-native.config.ts";

// Run after Cargo has built the native helper. Capture, UIA and foreground input
// use only owned fixture windows on the disposable CI desktop. The real-Windows
// cases share files with the macOS native tests; only the Windows ones run here.
export default defineConfig({
  test: {
    ...native.test,
    include: [
      "packages/screen/src/native.process.test.ts",
      "packages/screen/src/semantic.native.process.test.ts",
      // The --computer engine behind the agent tools, against the Rust fixture window.
      "packages/screen/src/computer/uia-engine.native.process.test.ts",
      "packages/screen/src/computer/policy-hosts.test.ts",
      "apps/daemon/src/services/computer-wiring.process.test.ts",
      // Windows open-app policy over the fake helper; its cases are the file's "Windows" ones.
      "packages/screen/src/mcp.process.test.ts",
    ],
    testNamePattern: /Windows/,
    maxWorkers: 1,
  },
});
