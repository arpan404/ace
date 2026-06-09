import { cn } from "~/lib/utils";
import { GLASS_BACKDROP_CLASS_NAME } from "~/components/ui/glass";

/** Shared modal chrome aligned with settings surfaces — flat, quiet borders, 13px type. */

export const MODAL_BACKDROP_CLASS_NAME = GLASS_BACKDROP_CLASS_NAME;

export const MODAL_SURFACE_CLASS_NAME = cn(
  "bg-popover text-popover-foreground",
  "border border-border/20",
  "shadow-[0_24px_64px_-36px] shadow-black/40",
  "supports-[backdrop-filter]:bg-popover/90 supports-[backdrop-filter]:backdrop-blur-2xl",
);

export const MODAL_HEADER_CLASS_NAME = "px-5 pt-5 pb-4 sm:px-6";

export const MODAL_BODY_CLASS_NAME = "px-5 sm:px-6";

export const MODAL_FOOTER_CLASS_NAME =
  "flex flex-col-reverse gap-2 border-t border-border/20 px-5 py-3.5 sm:flex-row sm:justify-end sm:px-6";

export const MODAL_TITLE_CLASS_NAME = "text-[13px] font-semibold leading-snug tracking-tight text-foreground";

export const MODAL_DIALOG_TITLE_CLASS_NAME =
  "text-[15px] font-semibold leading-snug tracking-tight text-foreground";

export const MODAL_DESCRIPTION_CLASS_NAME = "mt-2 text-xs leading-relaxed text-muted-foreground/75";

export const MODAL_DETAIL_CLASS_NAME =
  "rounded-[var(--control-radius)] border border-border/20 bg-muted/10 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground/80";

export const MODAL_CANCEL_BUTTON_CLASS_NAME = "h-8 px-3 text-[13px]";

export const MODAL_ACTION_BUTTON_CLASS_NAME = "h-8 px-3 text-[13px]";
