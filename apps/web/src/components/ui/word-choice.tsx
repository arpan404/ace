import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/cn.ts";

/**
 * One-of-n choice as words in a page toolbar ("Open 7 · Merged · Closed"): no track, no shadow.
 * The chosen word sits on the flat selected fill (`--active`, as the sidebar's open thread) in the
 * foreground at 500 with its count; the rest stay muted, and hover is a lighter wash. Pressing the current word keeps it chosen.
 */
export function WordChoice<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; count?: number | undefined }[];
  onValueChange(value: T): void;
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
      className={cn("flex items-center", props.className)}
    >
      {props.options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          aria-label={
            option.count === undefined
              ? undefined
              : `${option.label} ${option.count.toLocaleString()}`
          }
          className={cn(
            "group/word inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-ui whitespace-nowrap text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:bg-hover hover:text-foreground",
            "data-pressed:bg-active data-pressed:font-medium data-pressed:text-foreground",
          )}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="font-normal text-subtle-foreground tabular-nums group-data-pressed/word:text-muted-foreground">
              {option.count.toLocaleString()}
            </span>
          )}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
