import { cn } from "@/lib/cn.ts";

/**
 * ace's own logo, the app icon's glyph (apps/desktop/build/icon.svg): a lowercase "a", a ring
 * whose right side is an upright stem, on a rounded tile in the foreground colour. The window's
 * first paint draws the same mark in `index.html`, then the startup screen and pre-app cards.
 */
export function AceLogo(props: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={cn("shrink-0 rounded-[30%] bg-foreground text-background", props.className)}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M9.3 4.6a5.1 5.1 0 1 1 0 10.2a5.1 5.1 0 1 1 0 -10.2ZM9.3 6.4a3.3 3.3 0 1 0 0 6.6a3.3 3.3 0 1 0 0 -6.6Z"
      />
      <path fill="currentColor" d="M12.7 14.8V5.5a0.9 0.9 0 0 1 1.8 0V14.8Z" />
    </svg>
  );
}
