/** Shared by Menu, ContextMenu, Select and the palette so every list of actions looks the same. */
export const popupSurface =
  "glass rounded-lg p-1.5 text-ui text-popover-foreground outline-none origin-(--transform-origin) transition-[opacity,transform] duration-200 ease-spring data-starting-style:-translate-y-1 data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0";
export const menuItem =
  "flex h-[30px] w-full cursor-default items-center gap-[9px] rounded-md px-2.5 text-ui whitespace-nowrap text-foreground outline-none select-none data-highlighted:bg-accent data-disabled:opacity-50 [&_svg]:text-muted-foreground";
export const menuDanger = "text-destructive [&_svg]:text-destructive";
export const menuShortcut = "ml-auto pl-[18px] text-xs text-subtle-foreground";
export const menuSeparator = "mx-1.5 my-[5px] h-px bg-border";
export const menuLabel =
  "px-2.5 pt-[7px] pb-1 text-[11px] font-medium tracking-[0.02em] text-subtle-foreground";
