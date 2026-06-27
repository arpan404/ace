import { type ComponentProps } from "react";
import { cn } from "~/lib/utils";
import { HEADER_PILL_SURFACE_CLASS_NAME } from "./topBarClusterStyles";

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
