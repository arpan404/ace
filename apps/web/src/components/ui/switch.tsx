"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "~/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border/60 bg-muted/78 p-px shadow-inner outline-none transition-colors duration-200 supports-[backdrop-filter]:border-border/55 supports-[backdrop-filter]:bg-muted/64 supports-[backdrop-filter]:backdrop-blur-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:border-primary/35 data-checked:bg-primary data-checked:shadow-none data-unchecked:border-border/60 data-unchecked:bg-muted/78 data-disabled:cursor-not-allowed data-disabled:opacity-64 dark:data-unchecked:border-border/55 dark:data-unchecked:bg-foreground/[0.12] dark:data-unchecked:supports-[backdrop-filter]:bg-foreground/[0.12]",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block aspect-square h-[1.125rem] origin-left rounded-full border border-border/30 bg-background shadow-sm will-change-transform [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:not-data-disabled:scale-x-110 data-checked:origin-[1.125rem_50%] data-checked:translate-x-4 data-checked:border-transparent data-checked:bg-white data-checked:shadow-none dark:bg-foreground/92",
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
