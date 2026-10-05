import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
import { phosphorWeights } from "./icon-weights.ts";
import { reactPlugins } from "./react-plugins.ts";
import { zodWithoutJsonSchema } from "./zod-json-schema.ts";

// Tests use the committed route tree, so the generator plugin is not needed here.
export default defineProject({
  plugins: [...reactPlugins(), phosphorWeights(), zodWithoutJsonSchema()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
