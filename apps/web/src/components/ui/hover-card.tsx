import { PreviewCard } from "@base-ui/react/preview-card";
import { cn } from "@/lib/cn.ts";
import { layers, popupSurface, popupBounds } from "./menu-styles.ts";

const HoverCard = PreviewCard.Root;
const HoverCardTrigger = PreviewCard.Trigger;

function HoverCardContent({
  className,
  side = "right",
  align = "center",
  sideOffset = 10,
  ...props
}: PreviewCard.Popup.Props & Pick<PreviewCard.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <PreviewCard.Portal>
      <PreviewCard.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={layers.popup}
      >
        <PreviewCard.Popup
          data-slot="hover-card-content"
          className={cn(popupSurface, popupBounds, "p-3 motion-reduce:transition-none", className)}
          {...props}
        />
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
