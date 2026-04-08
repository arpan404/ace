import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";

import { Separator } from "../ui/separator";
import { cn } from "~/lib/utils";

export function TopBarCluster({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-px rounded-full border border-border/30 bg-background/70 p-1 shadow-sm shadow-black/5 supports-[backdrop-filter]:bg-background/50 supports-[backdrop-filter]:backdrop-blur-xl dark:shadow-black/20",
        "[&_[data-slot=toggle]]:rounded-full [&_[data-slot=toggle]]:bg-transparent [&_[data-slot=toggle]]:shadow-none [&_[data-slot=toggle]]:before:shadow-none",
        "[&_[data-slot=toggle]]:transition-[background-color,color,transform] [&_[data-slot=toggle]]:duration-150 [&_[data-slot=toggle]]:ease-out",
        "[&_[data-slot=toggle]]:hover:bg-foreground/[0.05] [&_[data-slot=toggle]]:active:bg-foreground/[0.08] [&_[data-slot=toggle][data-pressed]]:bg-background [&_[data-slot=toggle][data-pressed]]:shadow-sm",
        "[&_[data-slot=toggle]:disabled]:hover:bg-transparent [&_[data-slot=toggle][aria-disabled='true']]:hover:bg-transparent",
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
      className={cn("mx-0.5 h-3.5 bg-border/20", className)}
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
