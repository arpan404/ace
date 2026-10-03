import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import { phosphorWeights } from "./icon-weights.ts";
import { reactPlugins } from "./react-plugins.ts";

// Tests use the committed route tree, so the generator plugin is not needed here.
export default defineProject({
  plugins: [...reactPlugins(), phosphorWeights()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
