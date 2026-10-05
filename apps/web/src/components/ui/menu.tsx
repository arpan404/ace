import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { resolveKeys, useResolvedKeymap } from "@/lib/keybindings.ts";
import { describeKeys, type KeymapId } from "@/lib/keymap.ts";
import {
  layers,
  menuDanger,
  menuItem,
  menuLabel,
  menuSeparator,
  menuShortcut,
  popupSurface,
} from "./menu-styles.ts";

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;
const MenuGroup = MenuPrimitive.Group;
const MenuRadioGroup = MenuPrimitive.RadioGroup;
const MenuSub = MenuPrimitive.SubmenuRoot;

function MenuContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  anchor,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "side" | "align" | "sideOffset" | "anchor">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        anchor={anchor}
        className={cn(layers.popup, "isolate outline-none [-webkit-app-region:no-drag]")}
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(popupSurface, "min-w-[220px]", className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/**
 * The trailing shortcut text: a keymap id, or keys (a default follows its rebinding unless
 * `resolve` is false).
 */
function useShortcutText(
  shortcut: KeymapId | undefined,
  keys: string | undefined,
  resolve: boolean,
) {
  const resolved = useResolvedKeymap();
  const shown = shortcut
    ? resolved[shortcut]
    : keys && (resolve ? resolveKeys(keys, resolved) : keys);
  return shown ? describeKeys(shown) : undefined;
}

/**
 * One action. `icon` and `shortcut` (a keymap id) or `keys` render the leading glyph and
 * trailing shortcut. `reason` is a muted second line, for saying why a disabled item can't be
 * chosen yet.
 */
function MenuItem({
  className,
  icon,
  shortcut,
  keys,
  resolve = true,
  danger,
  reason,
  children,
  ...props
}: MenuPrimitive.Item.Props & {
  icon?: ReactNode;
  shortcut?: KeymapId;
  keys?: string;
  /** False: `keys` are this item's own, never a rebindable shortcut's. */
  resolve?: boolean;
  danger?: boolean;
  reason?: string | undefined;
}) {
  const shortcutText = useShortcutText(shortcut, keys, resolve);
  if (reason)
    // Two lines: the row grows past 30px, and only the label and icon dim when disabled, so
    // the reason keeps its contrast.
    return (
      <MenuPrimitive.Item
        className={cn(
          menuItem,
          "group/item h-auto min-h-[30px] items-start py-1.5 data-disabled:opacity-100",
          danger && menuDanger,
          className,
        )}
        {...props}
      >
        {icon && (
          <span className="mt-0.5 flex shrink-0 group-data-disabled/item:opacity-50">{icon}</span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate group-data-disabled/item:opacity-50">{children}</span>
          <span className="text-xs whitespace-normal text-subtle-foreground">{reason}</span>
        </span>
        {shortcutText && (
          <span className={cn(menuShortcut, "group-data-disabled/item:opacity-50")}>
            {shortcutText}
          </span>
        )}
      </MenuPrimitive.Item>
    );
  return (
    <MenuPrimitive.Item className={cn(menuItem, danger && menuDanger, className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcutText && <span className={menuShortcut}>{shortcutText}</span>}
    </MenuPrimitive.Item>
  );
}

function MenuSubTrigger({
  className,
  icon,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & { icon?: ReactNode }) {
  return (
    <MenuPrimitive.SubmenuTrigger className={cn(menuItem, className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <CaretRightIcon aria-hidden size={12} className="ml-auto size-3!" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem className={cn(menuItem, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <MenuPrimitive.RadioItemIndicator className="ml-auto">
        <CheckIcon aria-hidden size={14} />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

function MenuCheckboxItem({ className, children, ...props }: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(menuItem, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <MenuPrimitive.CheckboxItemIndicator className="ml-auto">
        <CheckIcon aria-hidden size={14} />
      </MenuPrimitive.CheckboxItemIndicator>
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator className={cn(menuSeparator, className)} {...props} />;
}

function MenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel className={cn(menuLabel, className)} {...props} />;
}

export {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuGroup,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuRadioGroup,
  MenuRadioItem,
  MenuCheckboxItem,
};
