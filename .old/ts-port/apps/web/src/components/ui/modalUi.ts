import { cn } from "~/lib/utils";
import { GLASS_BACKDROP_CLASS_NAME } from "~/components/ui/glass";

/** Shared modal chrome aligned with floating app surfaces — quiet glass, compact type. */

export const MODAL_BACKDROP_CLASS_NAME = GLASS_BACKDROP_CLASS_NAME;

export const MODAL_SURFACE_CLASS_NAME = cn(
  "overflow-hidden rounded-[1.15rem]",
  "border border-border/50 bg-[color:color-mix(in_oklch,var(--popover)_96%,var(--background)_4%)] text-popover-foreground",
  "shadow-[0_28px_80px_-48px_rgb(0_0_0/.62)]",
  "supports-[backdrop-filter]:backdrop-blur-2xl supports-[backdrop-filter]:backdrop-saturate-[1.12]",
  "dark:border-border/42 dark:bg-[color:color-mix(in_oklch,var(--popover)_92%,var(--background)_8%)] dark:shadow-[0_30px_90px_-50px_rgb(0_0_0/.86)]",
);

export const MODAL_HEADER_CLASS_NAME = "px-5 pt-5 pb-3 sm:px-6 sm:pt-6";

export const MODAL_BODY_CLASS_NAME = "px-5 sm:px-6";

export const MODAL_FOOTER_CLASS_NAME =
  "flex flex-col-reverse gap-2 px-5 pt-1 pb-5 sm:flex-row sm:justify-end sm:px-6 sm:pb-6";

export const MODAL_TITLE_CLASS_NAME =
  "text-[13px] font-semibold leading-snug tracking-tight text-foreground";

export const MODAL_DIALOG_TITLE_CLASS_NAME =
  "text-base font-semibold leading-tight tracking-tight text-foreground";

export const MODAL_DESCRIPTION_CLASS_NAME =
  "mt-2 max-w-prose text-[13px] leading-relaxed text-muted-foreground/72";

export const MODAL_DETAIL_CLASS_NAME =
  "rounded-[var(--control-radius)] border border-border/40 bg-muted/10 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground/80";

export const MODAL_CANCEL_BUTTON_CLASS_NAME = "h-8 px-3 text-[13px]";

export const MODAL_ACTION_BUTTON_CLASS_NAME = "h-8 px-3 text-[13px]";
