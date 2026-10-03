// @ts-check
/**
 * Module boundaries for the web app and the client packages (`bun run check:deps`).
 *
 * dependency-cruiser parses with swc because TypeScript 7 no longer ships the JS compiler API its
 * tsc parser needs (it prints a "missing-typescript-transpiler" note; swc sees every import,
 * type-only ones included). The `@/` alias comes from scripts/depcruise-resolve.cjs, so no
 * tsconfig parsing is involved.
 *
 * Layers of `apps/web/src` (see apps/web/README.md):
 * - foundation: components/, lib/, theme/, styles/, boot/ (never import features, app or routes)
 * - features/<x>/: a slice; other code reaches it only through `features/<x>/index.ts`
 * - app/: composition of several features (shell chrome, connection gate)
 * - routes/: thin TanStack file routes; may import feature public surfaces only
 */
const web = "^apps/web/src/";
/** What this config guards; everything else is resolved but neither followed nor reported. */
const scope = "^(apps/web/|packages/(client|client-react|fake-daemon|ui-core)/)";
/** Test-only code may reach a daemon or fixtures that production code must not. */
const testOnly = "(\\.test\\.tsx?|\\.fixture\\.ts|/test-support\\.ts)$";
const feature = `${web}features/([^/]+)/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular imports, type-only ones included, hide a missing seam.",
      from: { path: scope },
      to: { circular: true },
    },
    {
      name: "feature-public-surface",
      severity: "error",
      comment:
        "Another slice is reached only through its index.ts. Export what you need from there, or move shared code into the foundation or @ace/ui-core.",
      from: { path: feature },
      to: {
        path: `${web}features/[^/]+/.+`,
        pathNot: [`${web}features/$1/`, `${web}features/[^/]+/index\\.ts$`],
      },
    },
    {
      name: "feature-public-surface-outside",
      severity: "error",
      comment: "Routes, app composition and tests outside a slice import only its index.ts.",
      from: { path: web, pathNot: [`${feature}`] },
      to: { path: `${web}features/[^/]+/.+`, pathNot: `${web}features/[^/]+/index\\.ts$` },
    },
    {
      name: "foundation-not-features",
      severity: "error",
      comment: "components/, lib/, theme/, styles/ and boot/ sit below every feature.",
      from: { path: `${web}(components|lib|theme|styles|boot)/` },
      to: { path: `${web}(features|routes|app)/` },
    },
    {
      name: "features-not-routes-or-app",
      severity: "error",
      comment:
        "Routes and the app layer compose features, never the other way round. Tests may mount the whole app.",
      from: { path: `${web}features/`, pathNot: testOnly },
      to: { path: `${web}(routes|app)/|${web}(app|router|main)\\.tsx?$|routeTree\\.gen\\.ts$` },
    },
    {
      name: "app-not-routes",
      severity: "error",
      from: { path: `${web}app/` },
      to: { path: `${web}routes/` },
    },
    {
      name: "ui-core-headless",
      severity: "error",
      comment: "@ace/ui-core is shared with Expo: no React, DOM libraries or app code.",
      from: { path: "^packages/ui-core/" },
      to: {
        path: "^(apps/|packages/(client-react|fake-daemon)/)|node_modules/(react|react-dom|@tanstack|@phosphor-icons|@base-ui)/",
      },
    },
    {
      name: "ui-core-no-platform",
      severity: "error",
      comment: "@ace/ui-core runs in React Native too: no Node built-ins.",
      from: { path: "^packages/ui-core/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "packages-not-apps",
      severity: "error",
      comment: "Packages never reach into an app.",
      from: { path: "^packages/", pathNot: testOnly },
      to: { path: "^apps/" },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment: "An import that does not resolve is a typo or a missing dependency.",
      from: { path: scope },
      to: { couldNotResolve: true, dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    parser: "swc",
    doNotFollow: { path: `node_modules|^(?!${scope.slice(1)})` },
    exclude: { path: "(^|/)routeTree\\.gen\\.ts$|/node_modules/" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".d.ts"],
      mainFields: ["module", "main", "types"],
    },
    webpackConfig: { fileName: "scripts/depcruise-resolve.cjs" },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
