import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/cn.ts";

/** Single-value slider: 4px track, 18px white thumb. */
function Slider({
  className,
  label,
  ...props
}: Omit<SliderPrimitive.Root.Props<number>, "children"> & { label: string }) {
  return (
    <SliderPrimitive.Root data-slot="slider" className={cn("w-40", className)} {...props}>
      <SliderPrimitive.Control className="flex h-5 w-full cursor-pointer touch-none items-center px-[9px] select-none">
        <SliderPrimitive.Track className="h-1 w-full rounded-full bg-input">
          <SliderPrimitive.Indicator className="rounded-full bg-foreground/30" />
          <SliderPrimitive.Thumb
            aria-label={label}
            className="size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3),0_0_0_0.5px_rgb(0_0_0/0.1)] outline-none focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_45%,transparent)]"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
