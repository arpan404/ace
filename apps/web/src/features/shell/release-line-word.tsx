import { useDesktopUpdate } from "@/boot/desktop-updates.ts";

/**
 * The word "Beta" at the sidebar's foot, beside the update button, while ace runs a beta build
 * (ADR 0174): the desktop app's own build, or in a browser the daemon's, as its welcome said.
 * Plain text: no chip, no tint.
 */
export function ReleaseLineWord(props: { daemonLine?: string | undefined; scope?: object }) {
  const update = useDesktopUpdate(props.scope);
  const line = update.status?.buildLine ?? props.daemonLine;
  if (line !== "beta") return null;
  return (
    <span className="px-1 text-[11px] leading-none font-medium text-muted-foreground select-none">
      Beta
    </span>
  );
}
