import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";

import { Separator } from "../ui/separator";
import { cn } from "~/lib/utils";

export function TopBarCluster({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-0.5 rounded-[1rem] border border-border/70 bg-background/92 p-1 shadow-xs/5 supports-[backdrop-filter]:bg-background/78 supports-[backdrop-filter]:backdrop-blur-md",
        "[&_[data-slot=button]]:border-transparent [&_[data-slot=button]]:bg-transparent [&_[data-slot=button]]:shadow-none [&_[data-slot=button]]:before:shadow-none",
        "[&_[data-slot=button]]:hover:bg-accent/60 [&_[data-slot=button]:disabled]:hover:bg-transparent [&_[data-slot=button][aria-disabled='true']]:hover:bg-transparent",
        "[&_[data-slot=group]]:shrink-0",
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
      className={cn("mx-0.5 h-4 bg-border/55", className)}
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
