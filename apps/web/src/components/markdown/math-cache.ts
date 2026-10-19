import { LruCache } from "@ace/ui-core";
import { renderTex, type TexRenderer } from "./math-render.ts";

/*
 * Rendered math, remembered. KaTeX output for a (display flag, TeX source) pair
 * never changes within a session, so every message shares one bounded cache:
 * re-renders, virtualized rows remounting and the same formula appearing again
 * all hit it with zero KaTeX work. Bounded by entries and bytes (HTML strings
 * are a few KB); a heavier entry than the whole budget is not kept.
 */

export interface MathCacheOptions {
  maxEntries?: number | undefined;
  maxBytes?: number | undefined;
}

export interface MathCache {
  get(display: boolean, tex: string): string | undefined;
  set(display: boolean, tex: string, html: string): void;
  /** Entries held, for tests. */
  readonly size: number;
  /** Bytes held, for tests. */
  readonly weight: number;
}

const key = (display: boolean, tex: string) => `${display ? "d" : "i"}\n${tex}`;

export function createMathCache(options?: MathCacheOptions): MathCache {
  const entries = new LruCache<string, string>({
    maxEntries: options?.maxEntries ?? 1000,
    maxWeight: options?.maxBytes ?? 2 * 1024 * 1024,
    weigh: (html) => html.length,
  });
  return {
    get: (display, tex) => entries.get(key(display, tex)),
    set: (display, tex, html) => entries.set(key(display, tex), html),
    get size() {
      return entries.size;
    },
    get weight() {
      return entries.weight;
    },
  };
}

/** The cache every message shares on this thread. */
export const mathCache = createMathCache();

/** KaTeX registers itself here when its lazy chunk evaluates; unset until then. */
let renderer: TexRenderer | undefined;

/** Called by the KaTeX chunk on evaluation; tests inject fakes. */
export function setMathRenderer(next: TexRenderer | undefined): void {
  renderer = next;
}

/**
 * Cached HTML, or a synchronous render once KaTeX has loaded (pure: the same
 * TeX always gives the same HTML). Unsettled formulas and first views read
 * through here, so a warm formula commits its math with no source frame.
 */
export function renderMathCached(tex: string, display: boolean): string | undefined {
  const hit = mathCache.get(display, tex);
  if (hit !== undefined) return hit;
  if (!renderer) return undefined;
  const html = renderTex(renderer, tex, display);
  if (html === undefined) return undefined;
  mathCache.set(display, tex, html);
  return html;
}
