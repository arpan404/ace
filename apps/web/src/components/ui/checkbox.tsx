import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

/**
 * 14px square check ("Always allow" on approval cards). A hairline box at rest, ink fill
 * when checked; the focus ring is the accent. Pair it with a <label> for its name.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "grid size-3.5 shrink-0 place-items-center rounded-[4px] shadow-[inset_0_0_0_1px_var(--input)] outline-none transition-[background-color,box-shadow] duration-(--dur-1)",
        "focus-visible:shadow-[inset_0_0_0_1px_var(--input),0_0_0_2px_color-mix(in_oklab,var(--ring)_45%,transparent)]",
        "data-checked:bg-primary data-checked:shadow-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="text-primary-foreground">
        <CheckIcon aria-hidden size={10} weight="bold" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
