import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon } from "@phosphor-icons/react";
import { AccessMode } from "@ace/protocol";
import { Icon } from "@/components/icon.tsx";
import { MenuGroup } from "@/components/ui/menu.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { accessIcons } from "./permission-icons.ts";
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

/** The provider's supported access modes: a label and one muted line each. */
export function PermissionMenu(props: {
  view: PermissionMenuView;
  onChange(mode: AccessMode): void;
}) {
  const { view } = props;
  if (view.unavailable) return <Note>{view.unavailable}</Note>;
  if (view.loading) return <Note pending>Checking access modes…</Note>;
  if (!view.choices.length) return <Note>This agent sets its own access.</Note>;
  return (
    <MenuGroup>
      <MenuPrimitive.RadioGroup
        aria-label="Access"
        value={view.value ?? ""}
        onValueChange={(value: string) => {
          const mode = AccessMode.safeParse(value);
          if (mode.success) props.onChange(mode.data);
        }}
      >
        {view.choices.map((choice) => (
          <MenuPrimitive.RadioItem
            key={choice.mode}
            value={choice.mode}
            aria-label={choice.label}
            aria-description={choice.description}
            closeOnClick
            className={cn(menuItem, "h-auto items-start gap-2.5 px-2.5 py-1.5")}
          >
            <Icon
              icon={accessIcons[choice.mode]}
              className={cn("mt-0.5", choice.attention && "text-status-needs-you!")}
            />
            <span className="grid min-w-0 flex-1">
              <span className={cn("truncate", choice.attention && "text-status-needs-you")}>
                {choice.label}
              </span>
              <span className="truncate text-xs text-muted-foreground">{choice.description}</span>
            </span>
            <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
              <MenuPrimitive.RadioItemIndicator>
                <CheckIcon aria-hidden size={14} />
              </MenuPrimitive.RadioItemIndicator>
            </span>
          </MenuPrimitive.RadioItem>
        ))}
      </MenuPrimitive.RadioGroup>
    </MenuGroup>
  );
}
