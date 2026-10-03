import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/lib/cn.ts";
import type { KeymapId } from "@/lib/keymap.ts";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { Tip } from "./tooltip.tsx";

/**
 * A square icon-only button. The label is its accessible name and its tooltip, with the
 * shortcut beside it. `pressed` makes it a toggle: the icon fills and `aria-pressed` is set.
 */
function IconButton({
  icon,
  label,
  shortcut,
  keys,
  pressed,
  size = "default",
  tooltip = true,
  className,
  ...props
}: Omit<ButtonPrimitive.Props, "children"> & {
  icon: IconGlyph;
  label: string;
  shortcut?: KeymapId;
  keys?: string;
  pressed?: boolean;
  size?: "sm" | "default" | "lg";
  tooltip?: boolean;
}) {
  const button = (
    <ButtonPrimitive
      data-slot="icon-button"
      aria-label={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={cn(
        "inline-grid shrink-0 place-items-center text-muted-foreground transition-[background-color,color] duration-150 ease-smooth",
        "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground",
        "disabled:pointer-events-none disabled:opacity-40 data-disabled:pointer-events-none data-disabled:opacity-40",
        size === "sm" && "size-6 rounded-sm",
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
    <Tip label={label} {...(shortcut ? { shortcut } : {})} {...(keys ? { keys } : {})}>
      {button}
    </Tip>
  );
}

export { IconButton };
