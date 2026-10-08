import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/lib/cn.ts";
import type { KeymapId } from "@/lib/keymap.ts";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { Tip } from "./tooltip.tsx";

/**
 * A square icon-only button. The label is its accessible name and its tooltip, with the
 * shortcut beside it; `tip` words the tooltip shorter where the name says more ("Snooze" for
 * "Snooze Fix the login"). `pressed` makes it a toggle: the icon fills and `aria-pressed` is set.
 * Disabled with a `reason`, it stays focusable and hoverable (`aria-disabled`, clicks do
 * nothing), so its tooltip can say why it can't be used.
 */
function IconButton({
  icon,
  label,
  shortcut,
  keys,
  resolve,
  pressed,
  size = "default",
  tooltip = true,
  tip,
  reason,
  className,
  ...props
}: Omit<ButtonPrimitive.Props, "children"> & {
  icon: IconGlyph;
  label: string;
  shortcut?: KeymapId;
  keys?: string;
  /** False: `keys` are this button's own, never a rebindable shortcut's (Tip). */
  resolve?: boolean;
  pressed?: boolean;
  size?: "sm" | "default" | "lg";
  tooltip?: boolean;
  /** The tooltip's words when shorter than the accessible name. */
  tip?: string;
  /** Shown as the tooltip while disabled: why it can't be used now. */
  reason?: string | undefined;
}) {
  const button = (
    <ButtonPrimitive
      data-slot="icon-button"
      aria-label={label}
      focusableWhenDisabled={reason !== undefined}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={cn(
        "relative inline-grid shrink-0 place-items-center text-muted-foreground transition-[background-color,color,transform] duration-(--dur-1) ease-smooth focus-ring touch-hit active:scale-[0.94]",
        "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground",
        "disabled:pointer-events-none disabled:opacity-40 data-disabled:opacity-40",
        reason === undefined && "data-disabled:pointer-events-none",
        size === "sm" && "size-6 rounded-sm touch-hit-lg",
        size === "default" && "size-[30px] rounded-md",
        size === "lg" && "size-[34px] rounded-card",
        className,
      )}
      {...props}
    >
      <Icon icon={icon} size={size === "sm" ? 14 : size === "lg" ? 20 : 16} active={pressed} />
    </ButtonPrimitive>
  );
  if (!tooltip) return button;
  return (
    <Tip
      label={props.disabled && reason ? reason : (tip ?? label)}
      {...(props.disabled && reason ? {} : shortcut ? { shortcut } : {})}
      {...(props.disabled && reason ? {} : keys ? { keys } : {})}
      {...(resolve === false ? { resolve } : {})}
    >
      {button}
    </Tip>
  );
}

export { IconButton };
