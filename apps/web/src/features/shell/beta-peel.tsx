import { useId } from "react";
import { useDesktopUpdate } from "@/boot/desktop-updates.ts";

/** "ace 0.0.24 beta 1" for `0.0.24-beta.1`, as the release is titled; "ace beta" otherwise. */
export function betaName(version: string | null | undefined): string {
  const parts = version?.match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
  return parts ? `ace ${parts[1]} beta ${parts[2]}` : "ace beta";
}

/**
 * The beta build ace runs (ADR 0177), by name, or undefined on stable: the desktop app's own
 * build, or in a browser the daemon's line, as its welcome said.
 */
export function useBetaName(daemonLine?: string, scope?: object): string | undefined {
  const update = useDesktopUpdate(scope);
  const own = update.status?.buildLine;
  if ((own ?? daemonLine) !== "beta") return undefined;
  return betaName(own === "beta" ? update.status?.currentVersion : undefined);
}

/**
 * The beta's peel on the profile disc at the rail's foot, as on its Dock icon: the disc's
 * bottom-right edge curls back like a sticker, showing orange underneath. It overlays a 28px
 * disc in a `relative` box. Its colours are the icon's, not the theme's. The fold runs from the
 * disc's right edge (28, 14) to its foot (14, 28); the flap is the cut-off cap mirrored across it.
 */
export function BetaPeel() {
  const id = useId();
  return (
    <svg
      aria-hidden
      data-part="beta-peel"
      viewBox="0 0 28 28"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
    >
      <defs>
        <linearGradient
          id={`${id}under`}
          x1="20"
          y1="20"
          x2="28"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffb24a" />
          <stop offset="1" stopColor="#ff6a12" />
        </linearGradient>
        <linearGradient
          id={`${id}back`}
          x1="18"
          y1="18"
          x2="24"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#c4c5cc" />
        </linearGradient>
      </defs>
      <path d="M28 14A14 14 0 0 1 14 28Z" fill={`url(#${id}under)`} />
      <path
        d="M28 14A14 14 0 0 0 14 28Z"
        fill={`url(#${id}back)`}
        className="drop-shadow-[-0.5px_-0.5px_0.75px_rgb(0_0_0/0.4)]"
      />
    </svg>
  );
}
