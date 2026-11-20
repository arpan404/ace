import type { ReactNode } from "react";
import { menuItem, menuLabel, menuShortcut } from "@/components/ui/menu-styles.ts";
import { cn } from "@/lib/cn.ts";

/** A group's heading, as a macOS menu heads its sections ("Needs you", "In use"). */
export function TraySection(props: { label: string; children: ReactNode }) {
  return (
    <section aria-label={props.label}>
      <h2 className={menuLabel}>{props.label}</h2>
      {props.children}
    </section>
  );
}

/** One menu row: a command, with its shortcut or a trailing mark at the right. */
export function TrayCommand(props: {
  label: string;
  onClick(): void;
  shortcut?: string | undefined;
  end?: ReactNode;
  disabled?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(menuItem, "text-left hover:bg-accent")}
    >
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.shortcut && <span className={menuShortcut}>{props.shortcut}</span>}
      {props.end}
    </button>
  );
}

/** A list that scrolls past `max` without drawing a scrollbar, as a menu's long list does. */
export function TrayList(props: { children: ReactNode }) {
  return (
    <ul className="no-scrollbar flex max-h-[360px] flex-col overflow-y-auto overscroll-contain">
      {props.children}
    </ul>
  );
}

/** What a tab shows when it has nothing: one quiet line. */
export function TrayEmpty(props: { children: ReactNode }) {
  return <p className="px-2.5 py-3 text-ui text-muted-foreground">{props.children}</p>;
}
