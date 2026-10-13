import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/cn.ts";

/** Single-value slider: 4px track, 18px white thumb. Arrow, Page, Home and End keys move it. */
function Slider({
  className,
  label,
  valueText,
  ...props
}: Omit<SliderPrimitive.Root.Props<number>, "children"> & {
  label: string;
  /** How a value reads to assistive tech ("Solid", "60%"). */
  valueText?: ((value: number) => string) | undefined;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("w-40 data-disabled:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full cursor-pointer touch-none items-center px-[9px] select-none data-disabled:cursor-default">
        <SliderPrimitive.Track className="h-1 w-full rounded-full bg-input">
          <SliderPrimitive.Indicator className="rounded-full bg-ring" />
          <SliderPrimitive.Thumb
            aria-label={label}
            getAriaValueText={valueText ? (_formatted, value) => valueText(value) : undefined}
            className="size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3),0_0_0_0.5px_rgb(0_0_0/0.1)] outline-none focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_45%,transparent)]"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
