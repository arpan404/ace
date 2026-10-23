import type { Rolldown } from "vite";

type ChunkGroup = Exclude<NonNullable<Rolldown.OutputOptions["codeSplitting"]>, boolean>["groups"];

/**
 * Mermaid ships every diagram type as its own pre-bundled chunk and lazy-loads them, so the
 * first forge page with a ```mermaid block pulled ~90 lazy chunks into the web bundle and the
 * release crossed the installed updater's 2,048-entry archive budget (the oldest supported
 * updater's limits live in packages/service/src/artifact.ts and cannot be raised from here:
 * old apps would still refuse the archive).
 *
 * Everything below is only reachable through the one dynamic import in
 * `src/features/forge/rich/mermaid-diagram.tsx`, except `marked`, which the app's own markdown
 * renderer imports too – so `marked` stays in the automatic shared chunks. A dependency this
 * list misses stays a separate lazy chunk, which is still correct, just larger. Dependencies
 * are not pulled in recursively: that would also swallow `marked`, and every markdown page
 * would load the diagram renderer.
 */
const mermaidPackages = new Set([
  "@braintree/sanitize-url",
  "@chevrotain/gast",
  "@chevrotain/regexp-to-ast",
  "@chevrotain/utils",
  "@iconify/utils",
  "@mermaid-js/parser",
  "@upsetjs/venn.js",
  "chevrotain",
  "cose-base",
  "cytoscape",
  "cytoscape-cose-bilkent",
  "cytoscape-fcose",
  "d3",
  "d3-array",
  "d3-axis",
  "d3-brush",
  "d3-chord",
  "d3-color",
  "d3-contour",
  "d3-delaunay",
  "d3-dispatch",
  "d3-drag",
  "d3-dsv",
  "d3-ease",
  "d3-fetch",
  "d3-force",
  "d3-format",
  "d3-geo",
  "d3-hierarchy",
  "d3-interpolate",
  "d3-path",
  "d3-sankey",
  "d3-scale",
  "d3-scale-chromatic",
  "d3-selection",
  "d3-shape",
  "d3-time",
  "d3-time-format",
  "d3-timer",
  "d3-transition",
  "d3-zoom",
  "dagre",
  "dagre-d3-es",
  "dayjs",
  "dompurify",
  "elkjs",
  "es-toolkit",
  "graphlib",
  "khroma",
  "layout-base",
  "lodash-es",
  "mermaid",
  "roughjs",
  "stylis",
  "ts-dedent",
  "uuid",
]);

/** The npm package a module id belongs to, across flat and store (bun, pnpm) install layouts. */
function packageOf(id: string): string | undefined {
  const segments = id.split(/[\\/]/);
  let root = segments.lastIndexOf("node_modules");
  if (root < 0) return undefined;
  let first = segments[root + 1];
  if (first === undefined) return undefined;
  if (first.startsWith(".")) {
    // node_modules/.bun/<name>@<version>/node_modules/<name>/...
    root = segments.indexOf("node_modules", root + 1);
    if (root < 0) return undefined;
    first = segments[root + 1];
    if (first === undefined) return undefined;
  }
  if (!first.startsWith("@")) return first;
  const second = segments[root + 2];
  return second === undefined ? undefined : `${first}/${second}`;
}

/** One lazy chunk for the whole diagram renderer (ADR 0096): mermaid and its private closure. */
export function mermaidChunk(): NonNullable<ChunkGroup>[number] {
  return {
    debugName: "mermaid",
    priority: 10,
    includeDependenciesRecursively: false,
    test: (id) => mermaidPackages.has(packageOf(id) ?? ""),
    name: "mermaid",
  };
}
