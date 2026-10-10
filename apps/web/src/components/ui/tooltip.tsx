import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@/lib/cn.ts";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";

export const TooltipSide = createContext<TooltipPrimitive.Positioner.Props["side"]>("bottom");
import type { KeymapId } from "@/lib/keymap.ts";
import { Kbd } from "./kbd.tsx";
import { layers } from "./menu-styles.ts";

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
            "flex items-center gap-2 rounded-md border border-border bg-popover px-2 py-1 text-xs leading-4 font-normal break-words text-popover-foreground shadow-sm",
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
 * keymap id (`shortcut="agents"`) or keys (`keys="mod+enter"`); either follows the user's
 * rebinding, unless `resolve={false}` marks `keys` as a local command's own (find-bar Enter).
 */
function Tip(props: {
  label: ReactNode;
  shortcut?: KeymapId;
  keys?: string;
  /** False: `keys` are this control's own, never a rebindable shortcut's. */
  resolve?: boolean;
  side?: TooltipPrimitive.Positioner.Props["side"];
  /** A related popup already owns the trigger's description while it is open. */
  disabled?: boolean;
  children: ReactElement;
}) {
  const side = useContext(TooltipSide);
  return (
    <TooltipPrimitive.Root disabled={props.disabled}>
      <TooltipPrimitive.Trigger render={props.children} closeOnClick />
      <TooltipContent side={props.side ?? side}>
        <div className="min-w-0 break-words">{props.label}</div>
        {props.shortcut ? (
          <Kbd shortcut={props.shortcut} />
        ) : (
          props.keys && <Kbd keys={props.keys} resolve={props.resolve ?? true} />
        )}
      </TooltipContent>
    </TooltipPrimitive.Root>
  );
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

export { Tip, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
