import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { layers, popupBounds, popupSurface } from "./menu-styles.ts";

/** Navigation dismisses both controlled and uncontrolled popovers through Base UI. */
function Popover(props: PopoverPrimitive.Root.Props) {
  const router = useRouter({ warn: false });
  const actions = useRef<PopoverPrimitive.Root.Actions>(null);
  const ref = props.actionsRef ?? actions;
  useEffect(() => router?.subscribe("onBeforeNavigate", () => ref.current?.close()), [router, ref]);
  return <PopoverPrimitive.Root {...props} actionsRef={ref} />;
}
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
  anchor,
  collisionAvoidance,
  collisionBoundary,
  collisionPadding = 8,
  keepMounted,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    | "side"
    | "align"
    | "sideOffset"
    | "anchor"
    | "collisionAvoidance"
    | "collisionBoundary"
    | "collisionPadding"
  > &
  Pick<PopoverPrimitive.Portal.Props, "keepMounted">) {
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        className={cn(layers.popup, "isolate")}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(popupSurface, popupBounds, className)}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverClose, PopoverTitle, PopoverDescription };
