import { cn } from "@/lib/cn.ts";
import { AceWings } from "./ace-mark.tsx";

/**
 * ace's own logo, the app icon (apps/desktop/build/icon.svg): the ace mark on a rounded tile in
 * the foreground colour, the mark in the page colour. The window's first paint draws the same
 * logo in `index.html`, then the startup screen and pre-app cards.
 */
export function AceLogo(props: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={cn("shrink-0 rounded-[30%] bg-foreground text-background", props.className)}
    >
      <g fill="currentColor" transform="translate(3.76 4.33) scale(0.52)">
        <AceWings />
      </g>
    </svg>
  );
}
