import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@/lib/cn.ts";
import { popupSurface } from "./menu-styles.ts";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;
const PopoverTitle = PopoverPrimitive.Title;
const PopoverDescription = PopoverPrimitive.Description;

/**
 * Glass popover, 12px radius, fade + 4px rise on the spring curve. `keepMounted` keeps its
 * content mounted (hidden) while closed, for controls whose shortcuts must stay bound.
 */
function PopoverContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  keepMounted,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "side" | "align" | "sideOffset"> &
  Pick<PopoverPrimitive.Portal.Props, "keepMounted">) {
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="isolate z-[60]"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(popupSurface, "p-3", className)}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverClose, PopoverTitle, PopoverDescription };
