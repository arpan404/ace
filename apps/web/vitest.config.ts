import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

// Tests use the committed route tree, so the generator plugin is not needed here.
export default defineProject({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
