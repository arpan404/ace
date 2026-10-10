import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { MenuGroup } from "@/components/ui/menu.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
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

/** Native labels in compact rows; descriptions stay in tooltips. */
export function PermissionMenu(props: {
  view: PermissionMenuView;
  onChange(id: string | null): void;
}) {
  const { view } = props;
  if (view.unavailable) return <Note>{view.unavailable}</Note>;
  if (view.loading) return <Note pending>Checking available approval modes…</Note>;
  if (!view.options.length)
    return <Note>This provider doesn't report approval modes, so they can't be changed here.</Note>;
  const options = [
    {
      id: "",
      label: "Provider default",
      description: "Uses the provider's configured permissions.",
      risk: "medium" as const,
    },
    ...view.options,
  ];
  return (
    <>
      <MenuGroup>
        <MenuPrimitive.RadioGroup
          aria-label="Approvals"
          value={view.value ?? ""}
          onValueChange={(value: string) => {
            if (value === "") return props.onChange(null);
            const option = view.options.find((entry) => entry.id === value);
            if (option && !option.unavailable) props.onChange(option.id);
          }}
        >
          {options.map((option) => {
            const attention = option.risk === "high";
            return (
              <Tip key={option.id} label={option.description} side="right">
                <MenuPrimitive.RadioItem
                  value={option.id}
                  aria-label={option.label}
                  aria-description={option.description}
                  closeOnClick
                  className={cn(menuItem, "gap-2.5 px-2.5")}
                >
                  <Icon
                    icon={riskIcons[option.risk]}
                    className={cn(attention && "text-status-needs-you!")}
                  />
                  <span className={cn("min-w-0 flex-1", attention && "text-status-needs-you")}>
                    {option.label}
                  </span>
                  <span className="grid size-4 shrink-0 place-items-center">
                    <MenuPrimitive.RadioItemIndicator>
                      <CheckIcon aria-hidden size={14} />
                    </MenuPrimitive.RadioItemIndicator>
                  </span>
                </MenuPrimitive.RadioItem>
              </Tip>
            );
          })}
        </MenuPrimitive.RadioGroup>
      </MenuGroup>
    </>
  );
}
