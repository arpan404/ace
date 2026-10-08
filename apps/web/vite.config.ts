import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import { cssWithoutLegacyPolyfills } from "./css-polyfills.ts";
import { phosphorWeights } from "./icon-weights.ts";
import { initialChunk, initialPreloads } from "./initial-preloads.ts";
import { initialBundle } from "./initial-bundle.ts";
import { reactPlugins } from "./react-plugins.ts";
import { zodWithoutJsonSchema, zodWithoutMetadata } from "./zod-json-schema.ts";
import { droppedWorkerZodMethods, zodWithoutUnusedMethods } from "./zod-methods.ts";
import { workerBundle } from "./worker-bundle.ts";
import { zodPureSchemas } from "./zod-pure-schemas.ts";
import { notificationWorker } from "./notification-worker.ts";
import { workerZod } from "./worker-zod.ts";

const preloads = initialPreloads();

// The router plugin must precede the React plugin so route files are generated and split first.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true, quoteStyle: "double" }),
    ...reactPlugins(),
    tailwindcss(),
    cssWithoutLegacyPolyfills(),
    phosphorWeights(),
    zodWithoutJsonSchema(),
    zodWithoutMetadata(),
    zodWithoutUnusedMethods(),
    preloads.plugin,
    initialBundle(),
    notificationWorker(),
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
    plugins: () => [
      zodWithoutJsonSchema(),
      zodWithoutMetadata(),
      zodWithoutUnusedMethods(droppedWorkerZodMethods),
      zodPureSchemas(),
      workerZod(),
      workerBundle(),
    ],
    // Vite strips annotation, JSDoc and legal comments from the page's minified chunks but not from
    // workers', where `@__PURE__` and `@__NO_SIDE_EFFECTS__` alone were 0.5 KB gzip.
    rolldownOptions: { output: { comments: { annotation: false, jsdoc: false, legal: false } } },
  },
});
