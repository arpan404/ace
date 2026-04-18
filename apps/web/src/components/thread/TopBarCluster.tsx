import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";

import { Separator } from "../ui/separator";
import { cn } from "~/lib/utils";

export const HEADER_PILL_SURFACE_CLASS_NAME =
  "rounded-[var(--panel-radius)] border border-pill-border/72 bg-pill/92 supports-[backdrop-filter]:bg-pill/84 supports-[backdrop-filter]:backdrop-blur-lg";

export const HEADER_PILL_CONTROL_CLASS_NAME =
  "!h-7 !rounded-[var(--control-radius)] !border !border-transparent !bg-transparent !shadow-none gap-1 px-2.25 sm:px-2.75 text-[10px]/none font-medium text-pill-foreground/76 transition-[background-color,color,border-color,transform,opacity] duration-150 ease-out hover:!bg-foreground/[0.06] hover:text-pill-foreground active:!bg-foreground/[0.08] aria-expanded:!bg-foreground/[0.08] aria-expanded:text-pill-foreground disabled:text-pill-foreground/35 disabled:hover:!bg-transparent";

export const HEADER_PILL_ICON_CONTROL_CLASS_NAME = cn(
  HEADER_PILL_CONTROL_CLASS_NAME,
  "!size-7 !rounded-[var(--control-radius)] !px-0",
);

export const HEADER_PILL_TOGGLE_CONTROL_CLASS_NAME = cn(
  HEADER_PILL_ICON_CONTROL_CLASS_NAME,
  "data-[pressed]:!border-pill-border data-[pressed]:!bg-foreground/[0.08] data-[pressed]:!text-pill-foreground",
);

export const HEADER_PILL_TRIGGER_CLASS_NAME = cn(
  HEADER_PILL_SURFACE_CLASS_NAME,
  "h-6.5 sm:h-7 rounded-[var(--control-radius)] px-2.25 sm:px-2.75 text-[10px]/none font-medium text-pill-foreground transition-[transform,border-color,background-color,color] duration-150 ease-out hover:!bg-pill hover:border-pill-border hover:text-pill-foreground active:!bg-foreground/[0.06] disabled:pointer-events-none disabled:opacity-50",
);

export const HEADER_PILL_ICON_TRIGGER_CLASS_NAME = cn(
  HEADER_PILL_SURFACE_CLASS_NAME,
  "size-6.5 sm:size-7 rounded-[var(--control-radius)] px-0 text-pill-foreground transition-[transform,border-color,background-color,color] duration-150 ease-out hover:!bg-pill hover:border-pill-border hover:text-pill-foreground active:!bg-foreground/[0.06] disabled:pointer-events-none disabled:opacity-50",
);

export const HEADER_PILL_HERO_TRIGGER_CLASS_NAME = cn(
  HEADER_PILL_SURFACE_CLASS_NAME,
  "inline-flex h-8 sm:h-8.5 max-w-full items-center gap-1.75 px-3 sm:px-3.5 text-[12px] sm:text-[13px] font-medium text-pill-foreground transition-[border-color,background-color,color] duration-150 hover:border-pill-border hover:text-pill-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64",
);

export function TopBarCluster({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        HEADER_PILL_SURFACE_CLASS_NAME,
        "flex h-8 min-w-0 items-center gap-px overflow-hidden p-0.5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function TopBarClusterDivider({
  className,
  ...props
}: Omit<ComponentProps<typeof Separator>, "orientation">) {
  return (
    <Separator
      orientation="vertical"
      className={cn("mx-0.25 h-2.5 sm:h-3 bg-pill-border/50", className)}
      {...props}
    />
  );
}

export function interleaveTopBarItems(items: ReactNode[]) {
  const filteredItems = Children.toArray(items);
  return filteredItems.flatMap((item, index) =>
    index === 0
      ? [item]
      : [
          <TopBarClusterDivider
            key={
              isValidElement(item) && item.key !== null
                ? `divider-${String(item.key)}`
                : `divider-${String(item)}`
            }
          />,
          item,
        ],
  );
}
