import type { SuitDetail } from "@ace/protocol/suits";
import { useEffect, useState } from "react";
import { suitFontSources, type SuitFontSource } from "./suit-css.ts";

/*
 * A Suit's bundled fonts arrive before the Suit shows (ADR 0150, "Fonts"). Switching to a Suit
 * holds the look on screen until the new Suit's font files have loaded, so its text never draws
 * in a fallback face and then jumps; a font that takes longer than `suitFontWaitMs` stops
 * holding it. The first Suit of a page load shows at once (the boot record already painted it,
 * and its faces wait briefly for cached files themselves: `font-display: fallback`).
 *
 * Caching: every asset URL names one version of one Suit and is served
 * `Cache-Control: private, max-age=31536000, immutable`, so a reload in the same daemon run
 * reads each font from the browser's cache. A new daemon run issues new URLs, and the next
 * switch loads them once.
 */

export const suitFontWaitMs = 1500;

export type FontSource = SuitFontSource;

/** Loads font files and adds them to the page; resolves when all are usable or given up on. */
export interface SuitFontLoader {
  load(sources: readonly FontSource[]): Promise<void>;
}

/** The page's own loader, or undefined where the browser has no `FontFace` (tests, old engines). */
export function browserFontLoader(
  document: Document | undefined,
  wait = suitFontWaitMs,
): SuitFontLoader | undefined {
  const view = document?.defaultView;
  if (!document || !view || typeof view.FontFace !== "function") return undefined;
  const { FontFace } = view;
  return {
    async load(sources) {
      const loads = sources.map(async (source) => {
        const format = source.format ? ` format("${source.format}")` : "";
        const face = new FontFace(source.family, `url("${source.url}")${format}`, {
          display: "fallback",
          ...(source.weight ? { weight: source.weight } : {}),
          ...(source.style ? { style: source.style } : {}),
        });
        document.fonts.add(await face.load());
      });
      const timeUp = new Promise<void>((resolve) => view.setTimeout(resolve, wait));
      await Promise.race([Promise.allSettled(loads), timeUp]);
    },
  };
}

/**
 * `detail`, once its bundled fonts are loaded; until then, the Suit that was showing. A Suit
 * without bundled fonts, turning Suits off, and a page without a loader never wait.
 */
export function useSuitFontsReady(
  detail: SuitDetail | null,
  loader: SuitFontLoader | undefined,
): SuitDetail | null {
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState(detail);
  const [first] = useState(detail);
  const sources = detail ? suitFontSources(detail) : [];
  // The same version of the Suit with new URLs (a new daemon run) draws the same faces, which
  // the page already has under their family names: nothing to wait for.
  const sameLook =
    detail !== null &&
    shown !== null &&
    detail.summary.id === shown.summary.id &&
    detail.summary.contentHash === shown.summary.contentHash;
  const ready =
    loader === undefined ||
    detail === first ||
    sameLook ||
    sources.every((source) => settled.has(source.url));
  if (ready && shown !== detail) setShown(detail);

  const missing = ready ? "" : sources.map((source) => source.url).join("\n");
  useEffect(() => {
    if (!missing || !detail || !loader) return;
    let current = true;
    const wanted = suitFontSources(detail).filter((source) => missing.includes(source.url));
    void loader
      .load(wanted)
      .catch(() => undefined)
      .then(() => {
        if (current) setSettled((known) => new Set([...known, ...wanted.map((s) => s.url)]));
      });
    return () => {
      current = false;
    };
  }, [missing, detail, loader]);
  return ready ? detail : shown;
}
