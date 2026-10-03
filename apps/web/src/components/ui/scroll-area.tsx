import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "@/lib/cn.ts";

/** Overlay scrollbars that appear on hover or while scrolling. */
function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & { viewportClassName?: string }) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative min-h-0 overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className={cn("size-full outline-none", viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2.5 justify-center p-[3px] opacity-0 transition-opacity duration-(--dur-1) data-hovering:opacity-100 data-scrolling:opacity-100"
      >
        <ScrollAreaPrimitive.Thumb className="w-full rounded-full bg-[color-mix(in_oklab,var(--foreground)_18%,transparent)]" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}

export { ScrollArea };
