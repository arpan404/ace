import { cn } from "@/lib/cn.ts";
import { resolveKeys, useResolvedKeymap } from "@/lib/keybindings.ts";
import { formatKeys, type KeymapId } from "@/lib/keymap.ts";

/**
 * A key hint. `shortcut` shows what a keymap id is bound to now. `keys` uses the keymap
 * notation ("mod+k", "shift+mod+n", "g h") and renders platform glyphs; a keymap default
 * (`keymap.x.keys`) follows the user's rebinding unless `resolve={false}`. Children render
 * verbatim.
 */
function Kbd({
  className,
  shortcut,
  keys,
  resolve = true,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"kbd"> & {
  shortcut?: KeymapId;
  keys?: string;
  /** False: `keys` are already final (Settings › Keyboard shows a stored binding). */
  resolve?: boolean;
  /** `on-primary`: a plain dim key on an ink button, no box. */
  variant?: "default" | "bare" | "outline" | "on-primary";
}) {
  const resolved = useResolvedKeymap();
  const shown = shortcut
    ? resolved[shortcut]
    : keys && resolve
      ? resolveKeys(keys, resolved)
      : keys;
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4 min-w-[18px] items-center justify-center rounded-xs px-[5px] font-sans text-[11px] leading-4 font-medium tracking-[0.02em] text-subtle-foreground select-none",
        variant === "default" && "bg-secondary",
        variant === "outline" && "shadow-[inset_0_0_0_1px_var(--border)]",
        variant === "on-primary" && "px-0 text-current opacity-55",
        "in-data-[slot=tooltip-content]:bg-transparent in-data-[slot=tooltip-content]:px-0 in-data-[slot=tooltip-content]:text-current in-data-[slot=tooltip-content]:opacity-55",
        className,
      )}
      {...props}
    >
      {shown ? formatKeys(shown) : children}
    </kbd>
  );
}

export { Kbd };
