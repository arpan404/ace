import { Link } from "@tanstack/react-router";
import { useDesktopUpdate } from "@/boot/desktop-updates.ts";
import { AceMark } from "@/components/ace-mark.tsx";
import { railPlaceClass } from "@/components/rail-place.ts";
import { Tip } from "@/components/ui/tooltip.tsx";

/** "ace 0.0.24 beta 1" for `0.0.24-beta.1`, as the release is titled; "ace beta" otherwise. */
export function betaName(version: string | null | undefined): string {
  const parts = version?.match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
  return parts ? `ace ${parts[1]} beta ${parts[2]}` : "ace beta";
}

/**
 * The beta's mark at the sidebar's foot, beside the update button, while ace runs a beta build
 * (ADR 0177): the desktop app's own build, or in a browser the daemon's, as its welcome said.
 * A small porcelain tile, the beta's Dock icon in miniature, so the app and the Dock agree.
 * Its colours are the icon's, not the theme's. It opens General, where the release line is.
 */
export function ReleaseLineMark(props: { daemonLine?: string | undefined; scope?: object }) {
  const update = useDesktopUpdate(props.scope);
  const own = update.status?.buildLine;
  const line = own ?? props.daemonLine;
  if (line !== "beta") return null;
  const name = betaName(own === "beta" ? update.status?.currentVersion : undefined);
  return (
    <Tip label={name}>
      <Link
        to="/settings/general"
        aria-label={name}
        data-part="rail-item"
        className={railPlaceClass}
      >
        <span className="grid size-5 place-items-center rounded-[6px] bg-linear-to-b from-white to-[#d9dae0] text-[#16171a] shadow-[0_0_0_0.5px_rgb(0_0_0/0.18),0_1px_2px_rgb(0_0_0/0.18)]">
          <AceMark className="size-3.5" />
        </span>
      </Link>
    </Tip>
  );
}
