import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/cn.ts";

/** 34×20 track, accent when on, a knob in the accent's own label colour on the spring curve. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-part="switch"
      data-state={props.disabled ? "disabled" : props.checked ? "checked" : undefined}
      className={cn(
        "relative inline-flex h-5 w-[34px] shrink-0 rounded-full bg-input p-0.5 transition-colors duration-(--motion-base) data-checked:bg-ring data-disabled:opacity-50",
        "focus-ring touch-hit touch-hit-lg",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-part="switch-thumb"
        // The accent's label colour: white under light mode's ink track, near-black under dark
        // mode's light one, so an on switch never reads as a white knob on a white track.
        className="size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-(--motion-base) ease-spring data-checked:translate-x-3.5 data-checked:bg-tint-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
