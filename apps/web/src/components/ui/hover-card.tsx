import { PreviewCard } from "@base-ui/react/preview-card";
import { cn } from "@/lib/cn.ts";
import { FloatingContents, useFloatingMaterial } from "./floating-material.tsx";
import { layers, popupFrame, popupBounds } from "./menu-styles.ts";

const HoverCard = PreviewCard.Root;
const HoverCardTrigger = PreviewCard.Trigger;

function HoverCardContent({
  className,
  side = "right",
  align = "center",
  sideOffset = 10,
  collisionAvoidance,
  children,
  ...props
}: PreviewCard.Popup.Props &
  Pick<PreviewCard.Positioner.Props, "side" | "align" | "sideOffset" | "collisionAvoidance">) {
  const material = useFloatingMaterial();
  return (
    <PreviewCard.Portal>
      <PreviewCard.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        collisionAvoidance={collisionAvoidance}
        className={layers.popup}
      >
        <PreviewCard.Popup
          data-slot="hover-card-content"
          className={cn(
            material,
            popupFrame,
            popupBounds,
            "motion-reduce:transition-none",
            className,
          )}
          {...props}
        >
          <FloatingContents glass={material === "ace-floating"}>{children}</FloatingContents>
        </PreviewCard.Popup>
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
