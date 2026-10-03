import { cn } from "@/lib/cn.ts";
import { formatKeys } from "@/lib/keymap.ts";

/**
 * A key hint. `keys` uses the keymap notation ("mod+k", "shift+mod+n", "g h") and renders
 * platform glyphs; children render verbatim.
 */
function Kbd({
  className,
  keys,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"kbd"> & { keys?: string; variant?: "default" | "bare" | "outline" }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4 min-w-[18px] items-center justify-center rounded-xs px-[5px] font-sans text-[11px] leading-4 font-medium tracking-[0.02em] text-subtle-foreground select-none",
        variant === "default" && "bg-secondary",
        variant === "outline" && "shadow-[inset_0_0_0_1px_var(--border)]",
        "in-data-[slot=tooltip-content]:bg-transparent in-data-[slot=tooltip-content]:px-0 in-data-[slot=tooltip-content]:text-current in-data-[slot=tooltip-content]:opacity-55",
        className,
      )}
      {...props}
    >
      {keys ? formatKeys(keys) : children}
    </kbd>
  );
}

export { Kbd };
