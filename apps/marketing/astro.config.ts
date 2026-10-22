import { defineConfig } from "astro/config";

// A static site: every page is built to HTML at build time, with no client framework.
// Set `site` once the domain is chosen, so canonical and social-card URLs become absolute.
export default defineConfig({
  output: "static",
  build: { inlineStylesheets: "auto" },
});
