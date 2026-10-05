import { cn } from "@/lib/cn.ts";
import { resolveKeys, useResolvedKeymap } from "@/lib/keybindings.ts";
import { Fragment } from "react";
import { formatKeyParts, type KeymapId } from "@/lib/keymap.ts";

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
  const chip = cn(
    // No keys on a touch screen: hints would only be noise there.
    "pointer-events-none inline-flex h-4 min-w-[18px] items-center justify-center rounded-xs px-[5px] font-sans text-2xs leading-4 font-medium tracking-[0.02em] text-muted-foreground select-none pointer-coarse:hidden",
    variant === "default" && "bg-secondary",
    variant === "outline" && "shadow-[inset_0_0_0_1px_var(--border)]",
    variant === "on-primary" && "px-0 text-current opacity-55",
    "in-data-[slot=tooltip-content]:bg-transparent in-data-[slot=tooltip-content]:px-0 in-data-[slot=tooltip-content]:text-current in-data-[slot=tooltip-content]:opacity-55",
    className,
  );
  const parts = shown ? formatKeyParts(shown) : [];
  // A sequence ("g h") is keys pressed one after another, not together: one chip per key.
  if (parts.length > 1)
    return (
      <kbd
        data-slot="kbd"
        className={cn(
          "inline-flex items-center gap-1 font-sans text-2xs text-muted-foreground pointer-coarse:hidden",
          "in-data-[slot=tooltip-content]:text-current",
        )}
        {...props}
      >
        {parts
          .map((part, position) => ({ part, id: `${position}:${part}`, first: position === 0 }))
          .map((step) => (
            <Fragment key={step.id}>
              {!step.first && <span className="opacity-70">then</span>}
              <kbd className={chip}>{step.part}</kbd>
            </Fragment>
          ))}
      </kbd>
    );
  return (
    <kbd data-slot="kbd" className={chip} {...props}>
      {shown ? parts[0] : children}
    </kbd>
  );
}

export { Kbd };
