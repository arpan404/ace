import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/cn.ts";

/** 34×20 track, accent when on, white thumb on the spring curve. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-[34px] shrink-0 rounded-full bg-input p-0.5 transition-colors duration-(--dur-2) data-checked:bg-ring disabled:opacity-50",
        "focus-ring touch-hit-lg",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-(--dur-2) ease-spring data-checked:translate-x-3.5" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
