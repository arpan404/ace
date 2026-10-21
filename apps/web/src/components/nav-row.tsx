import { Link } from "@tanstack/react-router";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * A quiet row at the sidebar's foot that opens a full page (Pull requests): its glyph and name,
 * then at the right how many wait on the person, with the needs-you dot, or else a quiet count
 * of what is open there. The open page's row takes the selected fill.
 */
export function NavRow(props: {
  to: "/pulls";
  icon: IconGlyph;
  label: string;
  active: boolean;
  /** How many wait on the person; the dot and count show when above zero. */
  needsYou?: number | undefined;
  /** How many are open, shown quietly when none wait on the person. */
  open?: number | undefined;
}) {
  const waiting = props.needsYou ?? 0;
  const said =
    waiting > 0
      ? `${props.label}, ${waiting} ${waiting === 1 ? "needs" : "need"} you`
      : props.open
        ? `${props.label}, ${props.open} open`
        : props.label;
  return (
    <Link
      to={props.to}
      aria-current={props.active ? "page" : undefined}
      aria-label={said}
      className={cn(
        "group/nav flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-sidebar-accent hover:text-foreground pointer-coarse:h-11",
        props.active && "bg-sidebar-accent text-foreground",
      )}
    >
      <Icon
        icon={props.icon}
        className={cn(
          "shrink-0 text-faint-foreground transition-colors duration-(--motion-fast) group-hover/nav:text-muted-foreground",
          props.active && "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {waiting > 0 ? (
        <span
          aria-hidden
          data-tone="needs-you"
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-(--tone-text) tabular-nums"
        >
          <span className="size-1.5 rounded-full bg-(--tone)" />
          {waiting}
        </span>
      ) : props.open ? (
        <span aria-hidden className="shrink-0 text-xs text-subtle-foreground tabular-nums">
          {props.open}
        </span>
      ) : null}
    </Link>
  );
}
