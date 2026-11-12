/**
 * React entry for the markit renderer. Re-exports `@markit/web`'s React binding (installed
 * prebuilt from markit's release) so `apps/web` reaches markit only through `@ace/markit-web`.
 */
export { Markit, preloadMarkit, useMarkit } from "@markit/web/react";
export type { MarkitController, MarkitHookOptions, MarkitProps } from "@markit/web/react";
export { MarkitRenderer } from "@markit/web";
export type { HighlightedCode, MarkitOptions, RenderPatch } from "@markit/web";
