import { MonitorIcon } from "@phosphor-icons/react";
import { useAppIcon } from "@/lib/app-icons.ts";
import { cn } from "@/lib/cn.ts";

/** The OS icon on desktop; one monogram per app group when no icon is available. */
export function AppMark(props: {
  name: string;
  bundleId?: string | undefined;
  fallback?: "group" | "row" | undefined;
  className?: string;
}) {
  const icon = useAppIcon(props.bundleId);
  if (icon)
    return (
      <img
        src={icon}
        alt=""
        width={24}
        height={24}
        draggable={false}
        className={cn("size-6 shrink-0", props.className)}
      />
    );
  if (props.fallback === "row")
    return <MonitorIcon aria-hidden size={14} className={props.className} />;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-foreground/8 text-xs font-medium text-foreground",
        props.className,
      )}
    >
      {props.name.charAt(0).toUpperCase()}
    </span>
  );
}
