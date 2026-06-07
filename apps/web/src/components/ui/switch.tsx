"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "~/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 cursor-pointer items-center rounded-full border border-border/55 bg-muted/65 p-px shadow-inner outline-none transition-colors duration-200 [--thumb-size:--spacing(5)] supports-[backdrop-filter]:border-border/42 supports-[backdrop-filter]:bg-muted/48 supports-[backdrop-filter]:backdrop-blur-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:border-primary/25 data-checked:bg-primary/92 data-checked:shadow-none data-unchecked:border-border/55 data-unchecked:bg-muted/65 data-disabled:cursor-not-allowed data-disabled:opacity-64 dark:data-unchecked:border-border/40 dark:data-unchecked:supports-[backdrop-filter]:bg-input/55 sm:[--thumb-size:--spacing(4)]",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block aspect-square h-full origin-left in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:not-data-disabled:scale-x-110 in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.1)] rounded-(--thumb-size) border border-border/25 bg-background shadow-sm will-change-transform [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] data-checked:origin-[var(--thumb-size)_50%] data-checked:translate-x-[calc(var(--thumb-size)-4px)] data-checked:border-transparent data-checked:bg-white data-checked:shadow-none dark:bg-foreground/90",
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
