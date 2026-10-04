import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@/lib/cn.ts";
import type { ReactElement, ReactNode } from "react";
import { keymap, type KeymapId } from "@/lib/keymap.ts";
import { Kbd } from "./kbd.tsx";

function TooltipProvider({ delay = 500, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function TooltipContent({
  className,
  side = "bottom",
  sideOffset = 6,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, "side" | "sideOffset">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className="isolate z-[120]">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          role="tooltip"
          className={cn(
            "flex items-center gap-2 rounded-[7px] bg-primary px-2 py-[5px] text-[12px] leading-4 font-medium whitespace-nowrap text-primary-foreground",
            "origin-(--transform-origin) transition-[opacity,transform] duration-(--dur-1) ease-smooth data-ending-style:opacity-0 data-ending-style:duration-100 data-instant:duration-0 data-starting-style:opacity-0 data-[side=bottom]:data-starting-style:-translate-y-0.5 data-[side=top]:data-starting-style:translate-y-0.5",
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

/**
 * A tooltip around one trigger element, with the shortcut that does the same thing. Pass a
 * keymap id (`shortcut="agents"`) or literal keys (`keys="mod+enter"`).
 */
function Tip(props: {
  label: ReactNode;
  shortcut?: KeymapId;
  keys?: string;
  side?: TooltipPrimitive.Positioner.Props["side"];
  children: ReactElement;
}) {
  const keys = props.keys ?? (props.shortcut ? keymap[props.shortcut].keys : undefined);
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={props.children} />
      <TooltipContent side={props.side ?? "bottom"}>
        {props.label}
        {keys && <Kbd keys={keys} />}
      </TooltipContent>
    </TooltipPrimitive.Root>
  );
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export { Tip, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
