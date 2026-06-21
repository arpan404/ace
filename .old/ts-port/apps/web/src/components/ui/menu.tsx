"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ChevronRightIcon } from "lucide-react";
import * as React from "react";

import { useBoundaryDismissedOpen } from "./floatingBoundaryDismiss";
import { GLASS_MENU_ITEM_CLASS_NAME, GLASS_SURFACE_CLASS_NAME } from "./glass";
import { FLOATING_LAYER_CLASS_NAME } from "./layers";
import { cn } from "~/lib/utils";

const MenuCreateHandle = MenuPrimitive.createHandle;

function Menu<Payload = unknown>({
  defaultOpen,
  modal = false,
  onOpenChange,
  open,
  ...props
}: MenuPrimitive.Root.Props<Payload>) {
  const boundaryDismissedOpen = useBoundaryDismissedOpen<MenuPrimitive.Root.ChangeEventDetails>({
    defaultOpen,
    onOpenChange,
    open,
  });

  return <MenuPrimitive.Root modal={modal} {...boundaryDismissedOpen} {...props} />;
}

const MenuPortal = MenuPrimitive.Portal;

function MenuTrigger({ className, children, ...props }: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </MenuPrimitive.Trigger>
  );
}

function MenuPopup({
  children,
  className,
  listClassName,
  listHeight,
  sideOffset = 4,
  align = "center",
  alignOffset,
  side = "bottom",
  anchor,
  listMaxHeight,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  listClassName?: string;
  listHeight?: string;
  listMaxHeight?: string;
}) {
  const resolvedListHeight = listHeight ? `min(var(--available-height), ${listHeight})` : undefined;
  const listStyle: React.CSSProperties = {
    ...(resolvedListHeight ? { height: resolvedListHeight } : {}),
    maxHeight: listMaxHeight
      ? `min(var(--available-height), ${listMaxHeight})`
      : "var(--available-height)",
  };

  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className={FLOATING_LAYER_CLASS_NAME}
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "relative flex max-w-(--available-width) not-[class*='w-']:min-w-32 origin-(--transform-origin) rounded-[var(--panel-radius)] outline-none focus:outline-none",
            GLASS_SURFACE_CLASS_NAME,
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div
            className={cn("min-w-0 w-full overflow-y-auto p-1.5", listClassName)}
            style={listStyle}
          >
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "[&>svg]:-mx-0.5 flex min-h-8 cursor-default select-none items-center gap-2 rounded-[var(--chip-radius)] px-2 py-1 text-base text-foreground outline-none data-disabled:pointer-events-none data-inset:ps-8 data-[variant=destructive]:text-destructive-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg]:pointer-events-none [&>svg]:shrink-0",
        GLASS_MENU_ITEM_CLASS_NAME,
        className,
      )}
      data-inset={inset}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "switch";
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default items-center gap-2 rounded-[var(--chip-radius)] py-1 ps-2 text-base text-foreground outline-none data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        GLASS_MENU_ITEM_CLASS_NAME,
        variant === "switch" ? "grid-cols-[1fr_auto] gap-4 pe-1.5" : "grid-cols-[1rem_1fr] pe-4",
        className,
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      {variant === "switch" ? (
        <>
          <span className="col-start-1">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator
            className="inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border/60 bg-muted/78 p-px shadow-inner outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:border-primary/35 data-checked:bg-primary data-checked:shadow-none data-unchecked:border-border/60 data-unchecked:bg-muted/78 data-disabled:opacity-64 dark:data-unchecked:border-border/55 dark:data-unchecked:bg-foreground/[0.12]"
            data-slot="menu-checkbox-indicator"
            keepMounted
          >
            <span
              className="pointer-events-none block aspect-square h-[1.125rem] origin-left rounded-full border border-border/35 bg-background shadow-sm will-change-transform [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] in-[[data-slot=menu-checkbox-item]:active]:not-data-disabled:scale-x-110 in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[1.125rem_50%] in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-4 in-[[data-slot=menu-checkbox-item][data-checked]]:border-transparent in-[[data-slot=menu-checkbox-item][data-checked]]:bg-white dark:bg-foreground/92"
              data-slot="menu-checkbox-thumb"
            />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <MenuPrimitive.CheckboxItemIndicator className="col-start-1">
            <svg
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
          </MenuPrimitive.CheckboxItemIndicator>
          <span className="col-start-2">{children}</span>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-[var(--chip-radius)] py-1 ps-2 pe-4 text-base text-foreground outline-none data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        GLASS_MENU_ITEM_CLASS_NAME,
        className,
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <MenuPrimitive.RadioItemIndicator className="col-start-1">
        <svg
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </MenuPrimitive.RadioItemIndicator>
      <span className="col-start-2">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(
        "px-2 py-1.5 font-medium text-muted-foreground text-xs data-inset:ps-9 sm:data-inset:ps-8",
        className,
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-muted-foreground/72 text-xs tracking-widest",
        className,
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        "flex min-h-8 items-center gap-2 rounded-[var(--chip-radius)] px-2 py-1 text-base text-foreground outline-none data-disabled:pointer-events-none data-popup-open:bg-accent/55 data-inset:ps-8 data-popup-open:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none",
        GLASS_MENU_ITEM_CLASS_NAME,
        className,
      )}
      data-inset={inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto opacity-80" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  listClassName,
  sideOffset = 0,
  alignOffset,
  align = "start",
  listMaxHeight,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  listClassName?: string;
  listMaxHeight?: string;
}) {
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      side="inline-end"
      sideOffset={sideOffset}
      {...(listClassName !== undefined ? { listClassName } : {})}
      {...(listMaxHeight !== undefined ? { listMaxHeight } : {})}
      {...props}
    />
  );
}

export {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuShortcut,
};
