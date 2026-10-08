import { AppWindowIcon } from "@phosphor-icons/react";
import { useAppIcon } from "@/lib/app-icons.ts";
import { cn } from "@/lib/cn.ts";

/** The installed app's own OS icon; an app glyph while metadata isn't available. */
export function AppMark(props: { name: string; bundleId?: string; className?: string }) {
  const icon = useAppIcon(props.bundleId);
  const className = cn("size-5 shrink-0", props.className);
  return icon ? (
    <img alt="" src={icon} className={className} />
  ) : (
    <AppWindowIcon aria-hidden className={className} />
  );
}
