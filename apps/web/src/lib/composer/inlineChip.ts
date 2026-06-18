import { APP_CHIP_CLASS_NAME } from "../appChrome";
import { cn } from "../utils";

export const COMPOSER_INLINE_CHIP_CLASS_NAME = cn(
  "inline-flex max-w-full select-none items-center gap-1 px-1.5 py-0 font-medium text-[0.95em] leading-[1.2] text-foreground align-[-0.08em]",
  APP_CHIP_CLASS_NAME,
);

export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME = "size-3.5 shrink-0 opacity-85";

export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME = "truncate select-none leading-tight";

const COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME =
  "ml-0.5 inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
