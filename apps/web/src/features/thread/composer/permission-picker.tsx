import type { AccessMode } from "@ace/protocol";
import { accessDescription, accessLabel, type AccessSummary } from "@ace/ui-core";
import { Suspense } from "react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { chipControl } from "./composer-styles.ts";
import { DeferredPermissionMenu, MenuPending } from "./deferred-menus.tsx";
import { accessIcons, agentDefaultIcon, customIcon } from "./permission-icons.ts";
import type { PermissionMenuView } from "./permission-view.ts";

export type { PermissionMenuView } from "./permission-view.ts";

/** "Applies at the agent's next turn" read on after the mode's name: "applies at…". */
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

interface PermissionPickerProps {
  /** The access in effect and any pending change; undefined while it loads. */
  summary: AccessSummary | undefined;
  /** When a pending change applies: "Applies at the agent's next turn". */
  note?: string | undefined;
  menu: PermissionMenuView;
  onChange(mode: AccessMode): void;
}

/** Pure display projection: the chip names the mode that runs; the tip says what's pending. */
function accessDisplay(props: PermissionPickerProps) {
  const { summary, menu } = props;
  const shown = summary?.next ?? summary?.mode ?? undefined;
  const label = summary
    ? summary.next
      ? accessLabel(summary.next)
      : summary.label
    : menu.loading
      ? "Access…"
      : "Access";
  const Glyph = shown ? accessIcons[shown] : summary?.custom ? customIcon : agentDefaultIcon;
  const attention = shown === "full-access";
  const waits = summary?.next && props.note ? lower(props.note) : undefined;
  const tip = [
    summary?.custom ? `Custom: ${summary.custom}` : label,
    summary?.next && summary.mode ? `In effect: ${accessLabel(summary.mode)}` : undefined,
    shown ? accessDescription(shown) : undefined,
    summary?.stricter,
    waits,
  ]
    .filter(Boolean)
    .join(" · ");
  return { label, Glyph, attention, waits, tip };
}

export function PermissionPicker(props: PermissionPickerProps) {
  const { menu } = props;
  const { label, Glyph, attention, waits, tip } = accessDisplay(props);
  return (
    <Menu>
      <Tip label={menu.unavailable ?? tip} side="top">
        <MenuTrigger
          aria-label={`Access: ${label}${waits ? `, ${waits}` : ""}`}
          // Full access gates nothing; it reads in the attention colour.
          className={cn(
            chipControl,
            "w-fit max-w-40 shrink-0 justify-start text-ui",
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
        className="max-h-[var(--available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <Suspense fallback={<MenuPending />}>
          <DeferredPermissionMenu.Component view={menu} onChange={props.onChange} />
        </Suspense>
      </MenuContent>
    </Menu>
  );
}
