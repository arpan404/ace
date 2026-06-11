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

// Typography scale - use these consistently across the app
export const TYPOGRAPHY = {
  // Page/section titles
  pageTitle: "text-[13px]", // Settings page titles, modal titles
  dialogTitle: "text-[15px]", // Large dialog titles only
  sectionTitle: "text-[11px]", // Section headers, labels
  sectionTitleUppercase: "text-[11px] uppercase tracking-[0.08em]",

  // Body text
  rowTitle: "text-[13px]", // Settings row titles
  rowDescription: "text-xs leading-relaxed", // 12px
  rowStatus: "text-[11px]", // Status text

  // Small/meta text
  providerName: "text-[12px]", // Provider list items
  providerMeta: "text-[10px]", // Provider metadata
  sidebarItem: "text-[13px]", // Sidebar navigation
  compactAction: "text-xs", // 12px

  // Weights
  fontSemibold: "font-semibold",
  fontMedium: "font-medium",
  fontNormal: "font-normal",
} as const;

// Spacing scale - consistent padding/margins
export const SPACING = {
  // Content gutters
  contentGutter: "px-6 sm:px-10", // Settings content (24px mobile, 40px desktop)
  modalGutter: "px-5 sm:px-6", // Modal content (20px mobile, 24px desktop)

  // Section padding
  sectionCardBody: "px-3 sm:px-4", // Settings card body (12px mobile, 16px desktop)
  providerDetail: "px-3 py-3", // Provider sections

  // Vertical spacing
  sectionGap: "space-y-8", // Between sections
  rowGap: "py-3.5", // Between rows (14px)
} as const;

// Border styling - standardized
export const BORDERS = {
  // Use single consistent opacity - /40 is our standard
  default: "border-border/40",

  // Radius - only use CSS variables, no calculations
  radius: "rounded-[var(--control-radius)]",
  radiusSm: "rounded-[calc(var(--control-radius)-2px)]",
  radiusLg: "rounded-[var(--panel-radius)]",
  radiusFull: "rounded-full",
} as const;

// Focus rings - unified
export const FOCUS_RINGS = {
  // Default focus ring for interactive elements
  default: "focus-visible:ring-2 focus-visible:ring-ring/30",
  // Stronger focus ring for important controls
  strong: "focus-visible:ring-2 focus-visible:ring-ring",
  // Custom accent color
  accent: (color: string) => `focus-visible:ring-2 focus-visible:ring-[${color}]`,
} as const;

// Interactive states
export const INTERACTIVE = {
  hover: "transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground/85",
  hoverSubtle: "transition-colors duration-150 hover:bg-foreground/[0.04]",
  active: "active:bg-foreground/[0.08]",
} as const;

export const APP_WORKSPACE_CLASS_NAME = "bg-background text-foreground";

export const APP_CHROME_SIDEBAR_CLASS_NAME =
  "border-r border-sidebar-border/50 bg-sidebar text-sidebar-foreground";

export const APP_CHROME_HEADER_CLASS_NAME = "border-b border-border/40 bg-background";

export const APP_DOCKED_PANEL_CLASS_NAME = "bg-background";

export const APP_COMPOSER_CLASS_NAME =
  "rounded-[var(--panel-radius)] border border-border/40 bg-input shadow-none transition-[border-color,box-shadow] duration-150 focus-within:border-ring/45 focus-within:ring-2 focus-within:ring-ring/15";

export const APP_COMPOSER_HEADER_CLASS_NAME =
  "rounded-t-[calc(var(--panel-radius)-2px)] border-b border-border/40 bg-muted/25";

export const APP_USER_BUBBLE_CLASS_NAME =
  "rounded-2xl rounded-br-lg border border-border/40 bg-chat-bubble px-4 py-3";

export const APP_CHIP_CLASS_NAME =
  "rounded-[var(--chip-radius)] border border-border/40 bg-muted/35";

export const APP_BADGE_CLASS_NAME =
  "rounded-full border border-border/40 bg-muted/35 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground/75";

export const APP_INSET_BADGE_CLASS_NAME =
  "rounded-sm border border-border/40 glass-inset px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/72";

export const APP_COMPOSER_INSET_PANEL_CLASS_NAME =
  "overflow-hidden rounded-[var(--panel-radius)] border border-border/40 glass-inset text-popover-foreground";

export const APP_COMPOSER_CONTROL_CLASS_NAME =
  "shrink-0 rounded-[var(--control-radius)] text-muted-foreground/70 transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground/85 aria-expanded:bg-foreground/[0.05] aria-expanded:text-foreground/85";

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

export const APP_SIDEBAR_ITEM_CLASS_NAME =
  "transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground";

export const APP_INTERACTIVE_HOVER_CLASS_NAME =
  "transition-colors duration-150 hover:bg-foreground/[0.05] active:bg-foreground/[0.08]";

/** Rare elevated inset — error states, blocking notices. Not for page layout. */
export const APP_ELEVATED_INSET_CLASS_NAME =
  "rounded-[var(--panel-radius)] border border-border/40 bg-card";

/** Floating tool panel above workspace (env picker, anchored HUD) */
export const APP_FLOATING_PANEL_CLASS_NAME =
  "glass-surface rounded-[var(--panel-radius)] border text-popover-foreground";

// Stable aliases used across the app
export const APP_SHELL_CLASS_NAME = APP_WORKSPACE_CLASS_NAME;
export const APP_SIDEBAR_CLASS_NAME = APP_CHROME_SIDEBAR_CLASS_NAME;
export const APP_HEADER_CLASS_NAME = APP_CHROME_HEADER_CLASS_NAME;
export const APP_PANEL_CLASS_NAME = APP_DOCKED_PANEL_CLASS_NAME;
export const APP_BUBBLE_CLASS_NAME = APP_USER_BUBBLE_CLASS_NAME;
