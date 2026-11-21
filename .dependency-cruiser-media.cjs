// @ts-check
/**
 * ace-media is the only media pipeline (ADR 0147, docs/media/plan.md "Wave 7", X3): the daemon
 * never encodes a live video or picture envelope, so no daemon package may import the live
 * stream encoders (`@ace/browser/stream-encode`). Tests, benches and the fake daemon may: they
 * build what ace-media sends, to feed clients' decoders. A person's screenshot still crosses as
 * a still, through `stream-still.ts`, the one envelope the daemon writes.
 *
 * Run by `bun run check:deps` over the daemon's source roots, with only this rule, so the
 * client boundaries in `.dependency-cruiser.cjs` stay as they are.
 */
const testOnly =
  "(\\.test\\.tsx?|\\.fixture\\.ts|[-/]test-support\\.ts)$|(^|/)(test|testing)/|(^|/)bench/";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "daemon-no-video-envelopes",
      severity: "error",
      comment:
        "The daemon never encodes live video or picture envelopes: only ace-media delivers live views (X3). Send a still with stream-still.ts, or let ace-media deliver it.",
      from: {
        path: "^(apps/daemon/src|packages/(browser|screen|devices|media)/src)/",
        pathNot: [testOnly, "^packages/browser/src/stream-(encode|still)\\.ts$"],
      },
      to: { path: "^packages/browser/src/stream-encode\\.ts$" },
    },
  ],
  options: {
    parser: "swc",
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { path: testOnly },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "default"],
      extensions: [".ts", ".tsx", ".js", ".json"],
    },
  },
};
