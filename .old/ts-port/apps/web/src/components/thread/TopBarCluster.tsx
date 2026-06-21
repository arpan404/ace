import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";

import { Separator } from "../ui/separator";
import { cn } from "~/lib/utils";
import {
  HEADER_PILL_CONTROL_CLASS_NAME,
  HEADER_PILL_SURFACE_CLASS_NAME,
} from "./topBarClusterStyles";

const HEADER_PILL_ICON_CONTROL_CLASS_NAME = cn(
  HEADER_PILL_CONTROL_CLASS_NAME,
  "!size-7 !rounded-[var(--control-radius)] !px-0",
);

const HEADER_PILL_TOGGLE_CONTROL_CLASS_NAME = cn(
  HEADER_PILL_ICON_CONTROL_CLASS_NAME,
  "data-[pressed]:!border-pill-border data-[pressed]:!bg-foreground/[0.08] data-[pressed]:!text-pill-foreground  data-[pressed]:[&_svg]:scale-110 [&_svg]:transition-transform [&_svg]:duration-200",
);

const HEADER_PILL_ICON_TRIGGER_CLASS_NAME = cn(
  HEADER_PILL_SURFACE_CLASS_NAME,
  "size-6.5 sm:size-7 rounded-[var(--control-radius)] px-0 text-pill-foreground transition-[transform,border-color,background-color,color] duration-150 ease-out hover:!bg-pill hover:border-pill-border hover:text-pill-foreground active:!bg-foreground/[0.06] disabled:pointer-events-none disabled:opacity-50",
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

function TopBarClusterDivider({
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

function interleaveTopBarItems(items: ReactNode[]) {
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
