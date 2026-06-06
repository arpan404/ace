import { cn } from "~/lib/utils";

/**
 * Agentic coding UI tiers:
 * - Workspace: flat, readable surfaces (chat, editor, settings body)
 * - Chrome: structural rails (sidebar, headers) — hairline separation, no cards
 * - Elevated: inputs & floating panels that sit above workspace (composer, popovers)
 */

export const APP_WORKSPACE_CLASS_NAME = "bg-background text-foreground";

export const APP_CHROME_SIDEBAR_CLASS_NAME =
  "border-r border-sidebar-border/50 bg-sidebar text-sidebar-foreground";

export const APP_CHROME_HEADER_CLASS_NAME = "border-b border-border/25 bg-background";

export const APP_DOCKED_PANEL_CLASS_NAME = "bg-background";

export const APP_COMPOSER_CLASS_NAME =
  "rounded-[var(--panel-radius)] border border-border/40 bg-input shadow-none transition-[border-color,box-shadow] duration-150 focus-within:border-ring/45 focus-within:ring-2 focus-within:ring-ring/15";

export const APP_COMPOSER_HEADER_CLASS_NAME =
  "rounded-t-[calc(var(--panel-radius)-2px)] border-b border-border/35 bg-muted/40";

export const APP_USER_BUBBLE_CLASS_NAME =
  "rounded-2xl rounded-br-lg border border-border/40 bg-chat-bubble px-4 py-3";

export const APP_CHIP_CLASS_NAME =
  "rounded-[var(--chip-radius)] border border-border/60 bg-muted/50";

export const APP_SIDEBAR_ITEM_CLASS_NAME =
  "transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground";

export const APP_INTERACTIVE_HOVER_CLASS_NAME =
  "transition-colors duration-150 hover:bg-foreground/[0.05] active:bg-foreground/[0.08]";

/** Rare elevated inset — error states, blocking notices. Not for page layout. */
export const APP_ELEVATED_INSET_CLASS_NAME =
  "rounded-[var(--panel-radius)] border border-border/45 bg-card";

/** Floating tool panel above workspace (env picker, anchored HUD) */
export const APP_FLOATING_PANEL_CLASS_NAME =
  "glass-surface rounded-[var(--panel-radius)] border text-popover-foreground";

// Stable aliases used across the app
export const APP_SHELL_CLASS_NAME = APP_WORKSPACE_CLASS_NAME;
export const APP_SIDEBAR_CLASS_NAME = APP_CHROME_SIDEBAR_CLASS_NAME;
export const APP_HEADER_CLASS_NAME = APP_CHROME_HEADER_CLASS_NAME;
export const APP_PANEL_CLASS_NAME = APP_DOCKED_PANEL_CLASS_NAME;
export const APP_BUBBLE_CLASS_NAME = APP_USER_BUBBLE_CLASS_NAME;
