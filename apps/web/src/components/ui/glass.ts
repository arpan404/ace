/** Glass effects for floating overlays only — dialogs, menus, popovers, toasts. */

export const GLASS_BACKDROP_CLASS_NAME = "glass-backdrop";

export const GLASS_SURFACE_CLASS_NAME = "glass-surface border text-popover-foreground";

export const GLASS_CONTROL_CLASS_NAME =
  "border border-border/50 bg-background/55 shadow-none transition-[border-color,background-color,box-shadow] supports-[backdrop-filter]:bg-background/35 supports-[backdrop-filter]:backdrop-blur-md has-focus-visible:border-ring/55 has-focus-visible:ring-2 has-focus-visible:ring-ring/15 dark:bg-input/35 dark:has-focus-visible:bg-input/45";

export const GLASS_TOOLTIP_CLASS_NAME =
  "glass-surface glass-surface--tooltip border border-border/45 text-popover-foreground";

export const GLASS_PANEL_CLASS_NAME =
  "glass-surface glass-surface--tooltip glass-surface--panel border border-border/45 text-popover-foreground";

export const GLASS_BANNER_CLASS_NAME =
  "glass-banner overflow-hidden rounded-[var(--panel-radius)] border text-popover-foreground";

export const GLASS_BANNER_ERROR_CLASS_NAME = "glass-banner--error border-destructive/55";

export const GLASS_BANNER_WARNING_CLASS_NAME = "glass-banner--warning border-warning/55";

export const GLASS_FOOTER_CLASS_NAME =
  "border-t border-border/30 bg-muted/20 supports-[backdrop-filter]:bg-muted/12";

export const GLASS_MENU_ITEM_CLASS_NAME =
  "data-highlighted:bg-foreground/[0.06] data-highlighted:text-foreground dark:data-highlighted:bg-foreground/[0.08]";
