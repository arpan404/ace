import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@/lib/cn.ts";
import { layers } from "./menu-styles.ts";

/**
 * A tooltip's popup: placed by Floating UI beside its trigger. Loaded after the first paint
 * (`tooltip.tsx`), since nothing draws it until a pointer or focus has rested on a trigger.
 */
export function TooltipPopup({
  className,
  side = "bottom",
  sideOffset = 6,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, "side" | "sideOffset">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        collisionAvoidance={side === "top" ? { side: "none" } : undefined}
        sideOffset={sideOffset}
        className={cn(layers.tooltip, "isolate [-webkit-app-region:no-drag]")}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          role="tooltip"
          style={{ maxWidth: "min(20rem, calc(100vw - 24px))" }}
          className={cn(
            "ace-floating-solid flex items-center gap-2 rounded-sm px-2 py-1 text-xs leading-4 font-normal break-words text-popover-foreground",
            "origin-(--transform-origin) transition-[opacity,transform] duration-(--motion-fast) ease-smooth data-ending-style:opacity-0 data-ending-style:duration-100 data-instant:duration-0 data-starting-style:opacity-0 data-[side=bottom]:data-starting-style:-translate-y-[calc(var(--rise)/2)] data-[side=top]:data-starting-style:translate-y-[calc(var(--rise)/2)]",
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
