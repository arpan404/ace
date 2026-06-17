import { cn } from "~/lib/utils";

/**
 * Agentic coding UI tiers:
 * - Workspace: flat, readable surfaces (chat, editor, settings body)
 * - Chrome: structural rails (sidebar, headers) — hairline separation, no cards
 * - Elevated: inputs & floating panels that sit above workspace (composer, popovers)
 *
 * ============================================================================
 * DESIGN TOKENS - Centralized constants for consistent UI
 * ============================================================================
 */

const APP_WORKSPACE_CLASS_NAME = "bg-background text-foreground";

const APP_CHROME_SIDEBAR_CLASS_NAME =
  "border-r border-sidebar-border/50 bg-sidebar text-sidebar-foreground";

const APP_CHROME_HEADER_CLASS_NAME = "border-b border-border/40 bg-background";

const APP_DOCKED_PANEL_CLASS_NAME = "bg-background";

export const APP_COMPOSER_CLASS_NAME =
  "rounded-[1.625rem] border border-border/55 bg-[color:color-mix(in_oklch,var(--popover)_94%,var(--background)_6%)] shadow-[0_18px_48px_-36px_rgb(0_0_0/.72),0_1px_0_rgb(255_255_255/.08)_inset] transition-[background-color,border-color] duration-150 supports-[backdrop-filter]:backdrop-blur-2xl supports-[backdrop-filter]:backdrop-saturate-[1.16] dark:border-border/38 dark:bg-[color:color-mix(in_oklch,var(--popover)_92%,var(--background)_8%)]";

export const APP_COMPOSER_HEADER_CLASS_NAME =
  "rounded-t-[calc(var(--panel-radius)-2px)] border-b border-border/40 bg-muted/25";

export const APP_USER_BUBBLE_CLASS_NAME =
  "rounded-2xl rounded-br-lg border border-border/40 glass-inset px-4 py-3";

export const APP_CHIP_CLASS_NAME =
  "rounded-[var(--chip-radius)] border border-border/40 bg-muted/35";

export const APP_BADGE_CLASS_NAME =
  "rounded-full border border-border/40 bg-muted/35 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground/75";

export const APP_INSET_BADGE_CLASS_NAME =
  "rounded-sm border border-border/40 glass-inset px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/72";

export const APP_COMPOSER_INSET_PANEL_CLASS_NAME =
  "overflow-hidden rounded-[var(--panel-radius)] border border-border/40 glass-inset text-popover-foreground shadow-[0_12px_32px_-28px_rgb(0_0_0/.58),0_1px_0_rgb(255_255_255/.06)_inset]";

export const APP_COMPOSER_CONTROL_CLASS_NAME =
  "h-7 shrink-0 rounded-full px-2 text-[12px] font-normal text-muted-foreground/72 transition-colors duration-150 hover:bg-black/[0.06] hover:text-foreground/88 dark:hover:bg-white/[0.12]";

export const APP_WORKSPACE_INSET_CLASS_NAME = "rounded-md border border-border/40 glass-inset";

export const APP_FLOATING_CHIP_CLASS_NAME =
  "glass-surface glass-surface--compact rounded-full border text-popover-foreground";

export const APP_SETTINGS_FIELD_CLASS_NAME = "border-border/40 glass-inset shadow-none";

/** Menu trigger styling for settings pickers (model, traits, etc.). */
export const APP_SETTINGS_PICKER_TRIGGER_CLASS_NAME = cn(
  APP_SETTINGS_FIELD_CLASS_NAME,
  "h-8 min-w-0 shrink-0 justify-start px-2.5 text-[13px] font-normal text-foreground shadow-none hover:bg-foreground/[0.04]",
);

export const APP_FLOATING_TOOLBAR_CLASS_NAME =
  "glass-surface glass-surface--compact rounded-lg border text-popover-foreground shadow-none";

export const APP_EDITOR_CHROME_HEADER_CLASS_NAME = "border-b border-border/40 bg-background";

export const APP_INTERACTIVE_HOVER_CLASS_NAME =
  "transition-colors duration-150 hover:bg-foreground/[0.05] active:bg-foreground/[0.08]";

/** Rare elevated inset — error states, blocking notices. Not for page layout. */
export const APP_ELEVATED_INSET_CLASS_NAME =
  "rounded-[var(--panel-radius)] border border-border/40 bg-card";

// Stable aliases used across the app
export const APP_SHELL_CLASS_NAME = APP_WORKSPACE_CLASS_NAME;
export const APP_SIDEBAR_CLASS_NAME = APP_CHROME_SIDEBAR_CLASS_NAME;
export const APP_HEADER_CLASS_NAME = APP_CHROME_HEADER_CLASS_NAME;
export const APP_PANEL_CLASS_NAME = APP_DOCKED_PANEL_CLASS_NAME;
