/**
 * React entry for the markit renderer. Re-exports the submodule's React binding so
 * `apps/web` reaches markit only through `@ace/markit-web`, never a relative
 * `packages/markit/...` path.
 */
export { Markit, preloadMarkit, useMarkit } from "../../markit/web/react.js";
export type { MarkitController, MarkitHookOptions, MarkitProps } from "../../markit/web/react.js";
export { MarkitRenderer } from "../../markit/web/index.js";
export type { HighlightedCode, MarkitOptions, RenderPatch } from "../../markit/web/index.js";
