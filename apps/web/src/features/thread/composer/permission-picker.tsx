import type { PermissionOption } from "@ace/ui-core";
import { Suspense } from "react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { chipControl } from "./composer-styles.ts";
import { DeferredPermissionMenu, MenuPending } from "./deferred-menus.tsx";
import { riskIcons } from "./permission-icons.ts";
import type { PermissionMenuView } from "./permission-view.ts";

export type { PermissionMenuView } from "./permission-view.ts";

/** "Applies at the agent's next turn" read on after the mode's name: "applies at…". */
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The chosen permission stays readable beside its risk glyph; pending details live in the tooltip. */
interface PermissionPickerProps {
  /** The mode in effect. */
  current: PermissionOption | undefined;
  /** The mode chosen to replace it, not in effect yet. */
  next?: PermissionOption | undefined;
  /** When `next` applies: "Applies at the agent's next turn", "Will apply when reconnected". */
  note?: string | undefined;
  /** What the mode in effect gates, for the tooltip: "Protected reads not gated". */
  detail?: string | undefined;
  /** The mode comes from the default. */
  inherited?: boolean | undefined;
  menu: PermissionMenuView;
  onChange(id: string | null): void;
}

/** Pure display projection: pending selection and effective state stay distinct in the tip. */
function permissionDisplay(props: PermissionPickerProps) {
  const { current, next, menu } = props;
  const selected = menu.loading || menu.unavailable ? undefined : (next ?? current);
  const label = selected?.label ?? (menu.loading ? "Approvals…" : "Approvals");
  const Glyph = riskIcons[selected?.risk ?? "medium"];
  const attention = selected?.risk === "high";
  const waits = next && props.note ? lower(props.note) : undefined;
  const tip = [
    selected ? `Approvals: ${label}` : label,
    next && current ? `In effect: ${current.label}` : undefined,
    selected?.description ?? props.detail,
    menu.loading ? "Loading provider permission modes…" : undefined,
    menu.fallback,
    waits,
    props.inherited && !next ? "default" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return { label, Glyph, attention, waits, tip };
}

export function PermissionPicker(props: PermissionPickerProps) {
  const { menu } = props;
  const { label, Glyph, attention, waits, tip } = permissionDisplay(props);
  return (
    <Menu>
      <Tip label={menu.unavailable ?? tip} side="top">
        <MenuTrigger
          aria-label={`Approvals: ${label}${waits ? `, ${waits}` : ""}`}
          aria-description={menu.fallback}
          // Nothing gated reads in the attention colour: a quiet, constant warning.
          className={cn(
            chipControl,
            "w-fit max-w-40 shrink-0 justify-start text-sm",
            attention &&
              "text-status-needs-you hover:text-status-needs-you focus-visible:text-status-needs-you aria-expanded:text-status-needs-you",
          )}
        >
          <Glyph
            aria-hidden
            className="shrink-0"
            size={16}
            weight={attention ? "fill" : "regular"}
          />
          <span className="min-w-0 truncate">{label}</span>
        </MenuTrigger>
      </Tip>
      <MenuContent
        side="top"
        align="start"
        className="max-h-[var(--available-height)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <Suspense fallback={<MenuPending />}>
          <DeferredPermissionMenu.Component view={menu} onChange={props.onChange} />
        </Suspense>
      </MenuContent>
    </Menu>
  );
}
