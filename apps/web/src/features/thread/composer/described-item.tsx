import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { menuItem, menuShortcut } from "@/components/ui/menu-styles.ts";
import { cn } from "@/lib/cn.ts";
import { formatKeys } from "@/lib/keymap.ts";

/**
 * A menu row with a muted one-line description under its title, its keys on the right. With a
 * `reason` it is disabled and the reason takes the description's place, at full contrast.
 */
export function DescribedItem(props: {
  icon: ReactNode;
  children: ReactNode;
  description?: string | undefined;
  reason?: string | undefined;
  keys?: string | undefined;
  "aria-label"?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  const disabled = props.reason !== undefined || !props.onClick;
  return (
    <MenuPrimitive.Item
      disabled={disabled}
      aria-label={props["aria-label"]}
      onClick={props.onClick}
      className={cn(menuItem, "group/item h-auto min-h-[30px] py-1.5 data-disabled:opacity-100")}
    >
      <span className="flex shrink-0 self-start pt-0.5 group-data-disabled/item:opacity-50">
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate group-data-disabled/item:opacity-50">{props.children}</span>
        <span
          className={cn(
            "text-xs text-subtle-foreground",
            props.reason ? "whitespace-normal" : "truncate",
          )}
        >
          {props.reason ?? props.description}
        </span>
      </span>
      {props.keys && (
        <span className={cn(menuShortcut, "group-data-disabled/item:opacity-50")}>
          {formatKeys(props.keys)}
        </span>
      )}
    </MenuPrimitive.Item>
  );
}
