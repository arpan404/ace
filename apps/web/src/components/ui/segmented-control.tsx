import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";

/**
 * One-of-n choice (Unified / Split, Comfortable / Compact). The pressed segment lifts onto the
 * popover surface. Pressing the current segment keeps it selected.
 */
function SegmentedControl<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onValueChange(value: T): void;
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={props.label}
      value={[props.value]}
      onValueChange={(next) => {
        const picked = props.options.find((option) => option.value === next[0]);
        if (picked) props.onValueChange(picked.value);
      }}
      className={cn("inline-flex gap-0.5 rounded-md bg-secondary p-[3px]", props.className)}
    >
      {props.options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className={cn(
            "relative rounded-sm px-[11px] font-medium whitespace-nowrap text-muted-foreground transition-[background-color,color,box-shadow] duration-(--dur-1) focus-ring touch-hit hover:text-foreground",
            "data-pressed:bg-popover data-pressed:text-foreground data-pressed:shadow-raised",
            props.size === "sm" ? "h-[22px] text-[12px]" : "h-[26px] text-sm",
          )}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export { SegmentedControl };
