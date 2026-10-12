import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/cn.ts";
import type { CSSProperties, ReactNode } from "react";

/**
 * One-of-n choice (Light / Dark / System, Unified / Split). A pill track with a raised thumb
 * that slides to the pressed segment on the spring. Pressing the current segment keeps it
 * selected.
 */
function SegmentedControl<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onValueChange(value: T): void;
  size?: "sm" | "default";
  className?: string;
}) {
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value),
  );
  const style = { "--n": props.options.length, "--i": index } as CSSProperties;
  return (
    <ToggleGroup
      aria-label={props.label}
      value={[props.value]}
      onValueChange={(next) => {
        const picked = props.options.find((option) => option.value === next[0]);
        if (picked) props.onValueChange(picked.value);
      }}
      style={style}
      className={cn(
        "relative inline-grid auto-cols-fr grid-flow-col rounded-full bg-(--seg-bg) p-0.5",
        props.className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 w-[calc((100%-4px)/var(--n))] translate-x-[calc(var(--i)*100%)] rounded-full bg-(--seg-thumb) shadow-(--seg-thumb-shadow) transition-transform duration-(--motion-slow) ease-spring motion-reduce:transition-none"
      />
      {props.options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className={cn(
            "relative z-1 rounded-full text-center whitespace-nowrap text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:text-foreground",
            "data-pressed:font-medium data-pressed:text-foreground",
            props.size === "sm" ? "h-[22px] px-2.5 text-xs" : "h-7 px-3.5 text-sm",
          )}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export { SegmentedControl };
