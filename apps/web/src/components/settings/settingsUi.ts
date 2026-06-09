import { cn } from "~/lib/utils";
import {
  APP_SETTINGS_FIELD_CLASS_NAME,
  APP_SHELL_CLASS_NAME,
  APP_WORKSPACE_INSET_CLASS_NAME,
} from "~/lib/appChrome";

/** Matches thread / sidebar chrome — 13px base. */
export const SETTINGS_HEADER_ROOT_CLASS = "shrink-0 font-medium text-muted-foreground/80";

export const SETTINGS_HEADER_SEPARATOR_CLASS = "shrink-0 font-normal text-muted-foreground/30";

export const SETTINGS_HEADER_PAGE_CLASS = "min-w-0 truncate font-semibold text-foreground";

export const SETTINGS_PAGE_TITLE_CLASS =
  "flex min-w-0 items-center gap-2 text-[13px] leading-none tracking-tight";

export const SETTINGS_PAGE_DESCRIPTION_CLASS =
  "mt-2 max-w-prose text-xs leading-relaxed text-muted-foreground/75";

export const SETTINGS_CONTENT_MAX_WIDTH_CLASS = "max-w-4xl";

export const SETTINGS_CONTENT_GUTTER_CLASS = "px-6 sm:px-10";

export const SETTINGS_CONTENT_TOP_PADDING_CLASS = "pt-8 sm:pt-10";

export const SETTINGS_CONTENT_BOTTOM_PADDING_CLASS = "pb-10 sm:pb-12";

export const SETTINGS_SECTION_TITLE_CLASS =
  "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50";

export const SETTINGS_SECTION_DESCRIPTION_CLASS = "mt-1 text-xs leading-relaxed text-muted-foreground/65";

export const SETTINGS_ROW_TITLE_CLASS = "text-[13px] font-medium leading-snug text-foreground";

export const SETTINGS_ROW_DESCRIPTION_CLASS =
  "mt-0.5 text-xs leading-relaxed text-muted-foreground/70";

export const SETTINGS_ROW_STATUS_CLASS = "mt-1 text-[11px] text-muted-foreground/60";

export const SETTINGS_FIELD_LABEL_CLASS = "text-[13px] font-medium text-foreground";

export const SETTINGS_FIELD_HINT_CLASS = "mt-1 text-xs leading-relaxed text-muted-foreground/65";

export const SETTINGS_SUBSECTION_CLASS = "border-t border-border/20 pt-4 first:border-t-0 first:pt-0";

export const SETTINGS_GROUP_CLASS_NAME = "divide-y divide-border/40";

/** One card per settings section — rows stay flat inside. */
export const SETTINGS_SECTION_CARD_CLASS = cn(
  "overflow-hidden rounded-[var(--control-radius)] border border-border bg-card shadow-none",
);

export const SETTINGS_SECTION_CARD_BODY_CLASS = cn(
  SETTINGS_GROUP_CLASS_NAME,
  "px-3 sm:px-4",
);

/** Full-bleed card body for custom layouts (e.g. providers master-detail). */
export const SETTINGS_SECTION_CARD_FLUSH_BODY_CLASS = "min-w-0 overflow-hidden";

export const SETTINGS_SECTION_FRAME_CLASS = "min-w-0";

export const SETTINGS_ROW_CLASS = "py-3.5";

export const SETTINGS_COMPACT_CONTROL_CLASS = "w-full min-w-0 sm:w-52 sm:max-w-[14rem]";

export const SETTINGS_FIELD_CONTROL_CLASS = "w-full min-w-0";

export const SETTINGS_SHELL_CLASS = cn(APP_SHELL_CLASS_NAME, "text-foreground");

export const SETTINGS_FIELD_CLASS = cn(
  APP_SETTINGS_FIELD_CLASS_NAME,
  "h-8 rounded-[var(--control-radius)] shadow-none",
);

export const SETTINGS_INSET_PANEL_CLASS = cn(
  APP_WORKSPACE_INSET_CLASS_NAME,
  "overflow-hidden rounded-[var(--control-radius)]",
);

export const SETTINGS_SIDEBAR_FOCUS_RING_CLASS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/30";

export const SETTINGS_SIDEBAR_BACK_CLASS = cn(
  "mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
  SETTINGS_SIDEBAR_FOCUS_RING_CLASS,
);

export const SETTINGS_SIDEBAR_GROUP_LABEL_CLASS =
  "mb-1 h-auto px-2 py-0 text-[10px] font-semibold uppercase tracking-[0.1em] text-sidebar-foreground/35";

export const SETTINGS_SIDEBAR_ITEM_CLASS = cn(
  "h-7 rounded-md px-2 text-[13px] font-normal text-sidebar-foreground/60 shadow-none transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground data-[active=true]:bg-sidebar-accent/80 data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground",
  SETTINGS_SIDEBAR_FOCUS_RING_CLASS,
);

export const SETTINGS_COMPACT_ACTION_BUTTON_CLASS =
  "h-6 gap-1 px-2 text-xs font-normal [&_svg:not([class*='size-'])]:size-3";

export const SETTINGS_PROVIDER_LAYOUT_CLASS =
  "grid min-h-[32rem] grid-cols-1 lg:grid-cols-[minmax(11rem,13rem)_minmax(0,1fr)] lg:divide-x lg:divide-border/40";

export const SETTINGS_PROVIDER_LIST_ITEM_CLASS =
  "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors";

export const SETTINGS_PROVIDER_LIST_NAME_CLASS =
  "block truncate text-[12px] font-medium leading-tight text-foreground";

export const SETTINGS_PROVIDER_LIST_META_CLASS =
  "block truncate text-[10px] leading-tight text-muted-foreground/65";

export const SETTINGS_PROVIDER_DETAIL_HEADER_CLASS =
  "flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2.5";

export const SETTINGS_PROVIDER_DETAIL_TITLE_CLASS =
  "text-[13px] font-medium leading-tight text-foreground";

export const SETTINGS_PROVIDER_DETAIL_STATUS_CLASS =
  "text-[11px] leading-snug text-muted-foreground";

export const SETTINGS_PROVIDER_FIELD_LABEL_CLASS =
  "text-[12px] font-medium leading-snug text-foreground";

export const SETTINGS_PROVIDER_DETAIL_SECTION_CLASS =
  "border-b border-border px-3 py-3 last:border-b-0";

export const SETTINGS_CONTROL_SURFACE_CLASS_NAMES = [
  "[&_[data-slot=input-control]]:h-8",
  "[&_[data-slot=input-control]]:rounded-[var(--control-radius)]",
  "[&_[data-slot=input-control]]:border-border/40",
  "[&_[data-slot=input-control]]:bg-background/50",
  "[&_[data-slot=input-control]]:shadow-none",
  "[&_[data-slot=input]]:h-8",
  "[&_[data-slot=input]]:px-2.5",
  "[&_[data-slot=input]]:text-[13px]",
  "[&_[data-slot=select-button]]:h-8",
  "[&_[data-slot=select-button]]:rounded-[var(--control-radius)]",
  "[&_[data-slot=select-button]]:border-border/40",
  "[&_[data-slot=select-button]]:bg-background/50",
  "[&_[data-slot=select-button]]:text-[13px]",
  "[&_[data-slot=select-button]]:shadow-none",
  "[&_[data-slot=switch][data-checked]]:border-primary/25",
  "[&_[data-slot=switch][data-checked]]:bg-primary",
  "[&_button[data-slot=button][data-size=default]:not([data-size^=icon])]:h-8",
  "[&_button[data-slot=button][data-size=default]:not([data-size^=icon])]:rounded-[var(--control-radius)]",
  "[&_button[data-slot=button][data-size=default]:not([data-size^=icon])]:px-2.5",
  "[&_button[data-slot=button][data-size=default]:not([data-size^=icon])]:text-[13px]",
] as const;
