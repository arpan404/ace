import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import { phosphorWeights } from "./icon-weights.ts";
import { initialPreloads } from "./initial-preloads.ts";
import { reactPlugins } from "./react-plugins.ts";
import { zodWithoutJsonSchema, zodWithoutMetadata } from "./zod-json-schema.ts";

const preloads = initialPreloads();

// The router plugin must precede the React plugin so route files are generated and split first.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true, quoteStyle: "double" }),
    ...reactPlugins(),
    tailwindcss(),
    phosphorWeights(),
    zodWithoutJsonSchema(),
    zodWithoutMetadata(),
    preloads.plugin,
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    target: "es2023",
    sourcemap: true,
    modulePreload: { resolveDependencies: preloads.resolveDependencies },
  },
  // Workers (the client worker, markdown, diffs) are ES modules so they can share chunks.
  worker: { format: "es", plugins: () => [zodWithoutJsonSchema(), zodWithoutMetadata()] },
});
