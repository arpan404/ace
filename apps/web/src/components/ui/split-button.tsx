import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { CaretDownIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { Menu, MenuContent, MenuTrigger } from "./menu.tsx";
import { Tip } from "./tooltip.tsx";

/**
 * A primary action with a caret that opens its options, in one rounded control (Codex header
 * Run / Open / Commit). `label` is optional for icon-only actions; `actionLabel` then names it.
 */
function SplitButton(props: {
  icon?: ReactNode;
  label?: ReactNode;
  /** Accessible name and tooltip of the main action. */
  actionLabel: string;
  /** Accessible name of the caret. */
  menuLabel: string;
  onAction(): void;
  /** Menu items (`MenuItem`, `MenuRadioGroup`, …). */
  menu: ReactNode;
  variant?: "outline" | "ghost";
  shortcut?: string;
  disabled?: boolean;
  className?: string;
}) {
  const outline = (props.variant ?? "outline") === "outline";
  const region =
    "inline-flex h-full items-center outline-none transition-colors duration-(--dur-1) hover:bg-accent focus-visible:bg-accent disabled:opacity-50";
  return (
    <div
      data-slot="split-button"
      className={cn(
        "inline-flex h-[30px] shrink-0 items-stretch overflow-hidden rounded-md text-sm font-medium whitespace-nowrap text-foreground",
        outline && "shadow-[inset_0_0_0_1px_var(--border)]",
        props.className,
      )}
    >
      <Tip label={props.actionLabel} {...(props.shortcut ? { keys: props.shortcut } : {})}>
        <ButtonPrimitive
          aria-label={props.label ? undefined : props.actionLabel}
          disabled={props.disabled}
          onClick={props.onAction}
          className={cn(
            region,
            "gap-1.5 [&_svg]:text-muted-foreground",
            props.label ? "pr-1.5 pl-[9px]" : "px-2",
          )}
        >
          {props.icon}
          {props.label}
        </ButtonPrimitive>
      </Tip>
      <Menu>
        <MenuTrigger
          aria-label={props.menuLabel}
          disabled={props.disabled}
          className={cn(region, "pr-1.5 pl-0.5 text-subtle-foreground aria-expanded:bg-accent")}
        >
          <CaretDownIcon aria-hidden size={12} />
        </MenuTrigger>
        <MenuContent align="end">{props.menu}</MenuContent>
      </Menu>
    </div>
  );
}

export { SplitButton };
