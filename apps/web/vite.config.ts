import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import { phosphorWeights } from "./icon-weights.ts";
import { reactPlugins } from "./react-plugins.ts";

// The router plugin must precede the React plugin so route files are generated and split first.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true, quoteStyle: "double" }),
    ...reactPlugins(),
    tailwindcss(),
    phosphorWeights(),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { target: "es2023", sourcemap: true },
  // Workers (the client worker, markdown, diffs) are ES modules so they can share chunks.
  worker: { format: "es" },
});
