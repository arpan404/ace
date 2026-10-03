import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { formatKeys } from "@/lib/keymap.ts";
import {
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
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="isolate z-[110] outline-none"
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

/** One action. `icon` and `keys` render the leading glyph and trailing shortcut. */
function MenuItem({
  className,
  icon,
  keys,
  danger,
  children,
  ...props
}: MenuPrimitive.Item.Props & { icon?: ReactNode; keys?: string; danger?: boolean }) {
  return (
    <MenuPrimitive.Item className={cn(menuItem, danger && menuDanger, className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {keys && <span className={menuShortcut}>{formatKeys(keys)}</span>}
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
      <CaretRightIcon aria-hidden size={12} className="ml-auto" />
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
