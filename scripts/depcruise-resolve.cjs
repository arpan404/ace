// Resolution for dependency-cruiser: the web app's `@/` alias (apps/web/tsconfig.json paths).
const path = require("node:path");

module.exports = {
  resolve: { alias: { "@": path.join(__dirname, "../apps/web/src") } },
};
