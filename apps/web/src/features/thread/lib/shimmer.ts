import type { CSSProperties } from "react";

/**
 * The streaming status line's shimmer (DESIGN-fable.md, Motion). Inline because the vendored
 * shadcn stylesheet also defines a `.shimmer` utility that overrides the design's class.
 * Reduced motion turns the animation off globally.
 */
export const shimmer: CSSProperties = {
  background:
    "linear-gradient(90deg, var(--muted-foreground) 30%, var(--foreground) 50%, var(--muted-foreground) 70%) 0 0 / 220% 100%",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
  animation: "ace-shimmer 2.2s linear infinite",
};
