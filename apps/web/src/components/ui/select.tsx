import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { layers, menuItem, popupSurface } from "./menu-styles.ts";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean | undefined;
}

/**
 * A typed single-value select. The trigger is a quiet filled control; the list is a glass
 * menu with a check on the current value.
 */
function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onValueChange(value: T): void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SelectPrimitive.Root
      items={props.options}
      value={props.value}
      disabled={props.disabled ?? false}
      onValueChange={(value) => {
        const picked = props.options.find((option) => option.value === value);
        if (picked) props.onValueChange(picked.value);
      }}
    >
      <SelectPrimitive.Trigger
        aria-label={props.label}
        className={cn(
          "relative inline-flex h-8 items-center justify-between gap-2 rounded-md bg-secondary pr-2 pl-2.5 text-ui text-foreground transition-[background-color,box-shadow] duration-(--dur-1) focus-ring touch-hit",
          "hover:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_5%)] data-popup-open:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_5%)] disabled:opacity-50",
          // A minimum only for the default size: a Select given a width follows its column.
          props.className ?? "min-w-36",
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {props.options.find((option) => option.value === props.value)?.icon}
          <SelectPrimitive.Value className="truncate" />
        </span>
        <SelectPrimitive.Icon className="text-subtle-foreground transition-transform duration-(--dur-2) ease-spring in-data-popup-open:rotate-180">
          <CaretDownIcon aria-hidden size={12} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          alignItemWithTrigger={false}
          sideOffset={6}
          className={cn(layers.popup, "isolate outline-none [-webkit-app-region:no-drag]")}
        >
          <SelectPrimitive.Popup className={cn(popupSurface, "min-w-(--anchor-width)")}>
            <SelectPrimitive.List className="max-h-64 overflow-y-auto">
              {props.options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  aria-label={option.label}
                  disabled={option.disabled}
                  className={menuItem}
                >
                  {option.icon}
                  <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
                    {option.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="ml-auto">
                    <CheckIcon aria-hidden size={14} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select };
