import type { Plugin } from "vite";

/*
 * KaTeX ships each family as woff2, woff and ttf, but every browser ace runs
 * in renders woff2, so the other two are dead bytes (about three quarters of
 * the fonts' weight). After this transform each `@font-face` keeps only its
 * woff2 source, and Vite emits no woff or ttf.
 *
 * `font-display: swap` replaces KaTeX's `block`: a formula shows fallback
 * text at once instead of staying invisible for up to three seconds, then
 * swaps once the preloaded woff2 arrives. The swap window is usually empty
 * (fonts preload with the chunk) and display math reserves its height, so the
 * swap cannot move the page much.
 */

/** Keep each `@font-face`'s woff2 source; swap in place of a blocking display. */
export function withoutNonWoff2(css: string): string {
  return css
    .replace(/,\s*url\([^)]*\)\s*format\("woff"\)\s*,\s*url\([^)]*\)\s*format\("truetype"\)/g, "")
    .replace(/font-display:\s*block/g, "font-display:swap");
}

/** Applies {@link withoutNonWoff2} to KaTeX's stylesheet, in dev and in builds. */
export function katexWoff2(): Plugin {
  return {
    name: "ace:katex-woff2",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".css") || !id.includes("katex/dist/katex")) return undefined;
      const css = withoutNonWoff2(code);
      return css === code ? undefined : { code: css, map: null };
    },
  };
}
