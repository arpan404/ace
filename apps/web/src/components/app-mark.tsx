import { cn } from "@/lib/cn.ts";

/** An app's mark: its initial on a tile, wherever an app is named (computer use, approvals). */
export function AppMark(props: { name: string; className?: string }) {
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
