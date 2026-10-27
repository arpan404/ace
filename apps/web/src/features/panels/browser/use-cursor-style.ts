import { useEffect } from "react";
import { themedPalette } from "@ace/themes";
import { useTheme } from "@/theme/theme-provider.tsx";
import type { PreviewSource } from "../sources.ts";

/**
 * Agents' cursors are drawn in the page in the person's accent (ADR 0082): tell the daemon the
 * accent on screen, and again whenever the theme, mode or accent changes. The outline is the
 * accent's own label colour, so a pale accent (Ink in dark mode) gets a dark edge.
 */
export function useCursorStyle(source: PreviewSource, threadId: string): void {
  const { appearance, resolved } = useTheme();
  const palette = themedPalette(resolved.theme, resolved.scheme, appearance);
  const fill = palette.accent;
  const outline = palette.accentFg;
  useEffect(() => {
    if (/^#[0-9a-f]{6}$/i.test(fill) && /^#[0-9a-f]{6}$/i.test(outline))
      source.cursorStyle?.(threadId, { fill, outline });
  }, [source, threadId, fill, outline]);
}
