import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, InfoIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { MenuGroup, MenuLabel } from "@/components/ui/menu.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { riskIcons } from "./permission-icons.ts";
import type { PermissionMenuView } from "./permission-view.ts";

function Note(props: { children: string; pending?: boolean }) {
  return (
    <p
      role="status"
      className="flex min-h-8 items-center gap-2 px-2.5 py-2 text-xs leading-4 text-muted-foreground"
    >
      {props.pending && <Spinner />}
      {props.children}
    </p>
  );
}

/**
 * The approval modes the provider offers, each with what it means in one line, then once what
 * the provider gates in the mode in effect. A mode it can't honour shows disabled, with why. A
 * thread with its own mode can go back to the default, unless the provider can't run in it.
 * It reads a generic `{id, label, description, risk}` list, so a provider's native modes need
 * nothing of their own.
 */
export function PermissionMenu(props: {
  view: PermissionMenuView;
  onChange(id: string | null): void;
}) {
  const { view } = props;
  if (view.unavailable) return <Note>{view.unavailable}</Note>;
  if (view.loading) return <Note pending>Checking what the provider can gate…</Note>;
  if (!view.options.length)
    return <Note>This provider doesn't report approval modes, so they can't be changed here.</Note>;
  return (
    <>
      {view.fallback && <Note>{view.fallback}</Note>}
      <MenuGroup>
        <MenuLabel>Approvals</MenuLabel>
        <MenuPrimitive.RadioGroup
          value={view.value ?? ""}
          onValueChange={(value: string) => {
            if (value === "") return props.onChange(null);
            const option = view.options.find((entry) => entry.id === value);
            if (option && !option.unavailable) props.onChange(option.id);
          }}
        >
          {[
            {
              id: "",
              label: "Provider default",
              description: "Use the default from Settings or the provider's own configuration.",
              risk: "medium" as const,
            },
            ...view.options,
          ].map((option) => {
            const attention = option.risk === "high";
            return (
              <MenuPrimitive.RadioItem
                key={option.id}
                value={option.id}
                aria-label={option.label}
                disabled={!!option.unavailable}
                closeOnClick
                className={cn(menuItem, "h-auto items-start py-2")}
              >
                <Icon
                  icon={riskIcons[option.risk]}
                  className={cn("mt-px", attention && "text-status-needs-you!")}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 whitespace-normal">
                  <span className={cn(attention && "text-status-needs-you")}>{option.label}</span>
                  <span className="text-xs leading-4 text-muted-foreground">
                    {option.unavailable ?? option.description}
                  </span>
                </span>
                <span className="grid size-4 shrink-0 place-items-center">
                  <MenuPrimitive.RadioItemIndicator>
                    <CheckIcon aria-hidden size={14} />
                  </MenuPrimitive.RadioItemIndicator>
                </span>
              </MenuPrimitive.RadioItem>
            );
          })}
        </MenuPrimitive.RadioGroup>
      </MenuGroup>
      {view.coverage && (
        <p className="flex items-start gap-2 px-2.5 pt-1.5 pb-1 text-xs leading-4 text-subtle-foreground">
          <InfoIcon aria-hidden size={14} className="mt-px shrink-0" />
          {view.coverage}
        </p>
      )}
    </>
  );
}
