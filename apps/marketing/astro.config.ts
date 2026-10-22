import { defineConfig } from "astro/config";

// The site's public address, such as https://example.com. Canonical links, the sitemap and
// absolute social-card URLs need it; without it the build still works and leaves them out.
const site = process.env.SITE_URL?.trim() || undefined;

// A static site: every page is built to HTML at build time, with no client framework.
export default defineConfig({
  ...(site ? { site } : {}),
  output: "static",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "auto", format: "directory" },
});
