import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import { phosphorWeights } from "./icon-weights.ts";
import { initialChunk, initialPreloads } from "./initial-preloads.ts";
import { reactPlugins } from "./react-plugins.ts";
import { zodWithoutJsonSchema, zodWithoutMetadata } from "./zod-json-schema.ts";
import { zodWithoutUnusedMethods } from "./zod-methods.ts";

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
    zodWithoutUnusedMethods(),
    preloads.plugin,
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    target: "es2023",
    sourcemap: true,
    modulePreload: { resolveDependencies: preloads.resolveDependencies },
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [initialChunk(fileURLToPath(new URL("./src/main.tsx", import.meta.url)))],
        },
      },
    },
  },
  // Workers (the client worker, markdown, diffs) are ES modules so they can share chunks.
  worker: {
    format: "es",
    plugins: () => [zodWithoutJsonSchema(), zodWithoutMetadata(), zodWithoutUnusedMethods()],
    // Vite strips annotation, JSDoc and legal comments from the page's minified chunks but not from
    // workers', where `@__PURE__` and `@__NO_SIDE_EFFECTS__` alone were 0.5 KB gzip.
    rolldownOptions: { output: { comments: { annotation: false, jsdoc: false, legal: false } } },
  },
});
