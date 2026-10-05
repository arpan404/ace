import type { PermissionCapabilities, PermissionMode, ProviderKind } from "@ace/protocol";
import {
  permissionChipText,
  permissionCoverage,
  permissionLabel,
  permissionNeedsAttention,
} from "@ace/ui-core";
import { ClockIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { Suspense } from "react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { chipControl } from "./composer-styles.ts";
import { DeferredPermissionMenu, MenuPending } from "./deferred-menus.tsx";
import { permissionIcons } from "./permission-icons.ts";

/** "Applies at the agent's next turn" read on after the mode's name: "applies at…". */
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * How the agent's actions get approved: a quiet button in the composer's footer with the mode's
 * icon and name, the default (Auto-review) included. It shows the mode in effect; while a change
 * waits for the agent's next turn it shows both, "Auto-review → Full access", with a small
 * clock, and the tooltip says when the change applies. The provider's real coverage is in the
 * tooltip and menu. Full access is the one mode whose icon is drawn in the attention colour.
 */
export function PermissionPicker(props: {
  /** The mode in effect. */
  mode: PermissionMode | undefined;
  capabilities: PermissionCapabilities | undefined;
  /** Whose modes these are, for the menu's note on what they gate. */
  provider?: ProviderKind | undefined;
  loading: boolean;
  /** Why the mode can't be chosen here, e.g. the daemon couldn't report the provider's modes. */
  unavailable?: string | undefined;
  /** The mode chosen to replace `mode`, not in effect yet. */
  next?: PermissionMode | undefined;
  /** When `next` applies: "Applies at the agent's next turn", "Will apply when reconnected". */
  note?: string | undefined;
  /** The mode comes from the default; the menu offers to go back to it. */
  inherited?: boolean | undefined;
  /** A thread's default, offered as "Use the default" when it has its own mode. */
  defaultMode?: PermissionMode | undefined;
  onChange(mode: PermissionMode | null): void;
}) {
  const { mode, next } = props;
  const label = mode ? permissionLabel(mode) : props.loading ? "Approvals…" : "Approvals";
  const Glyph = mode ? permissionIcons[mode] : ShieldCheckIcon;
  const attention = !!mode && permissionNeedsAttention(mode);
  const waits = next && props.note ? `${permissionLabel(next)} ${lower(props.note)}` : undefined;
  const tip = [
    mode ? `${label} · ${permissionCoverage(props.capabilities, mode)}` : label,
    waits,
    props.inherited ? "default" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Menu>
      <Tip label={props.unavailable ?? tip} side="top">
        <MenuTrigger
          aria-label={`Approvals: ${label}${waits ? `, ${waits}` : ""}`}
          className={chipControl}
        >
          <Glyph
            aria-hidden
            size={16}
            weight={attention ? "fill" : "regular"}
            className={cn("shrink-0", attention && "text-status-needs-you")}
          />
          {mode && <span className="truncate">{permissionChipText(mode, next)}</span>}
          {next && <ClockIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />}
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" align="start" className="w-[320px]">
        <Suspense fallback={<MenuPending />}>
          <DeferredPermissionMenu.Component
            mode={next ?? mode}
            capabilities={props.capabilities}
            provider={props.provider}
            loading={props.loading}
            unavailable={props.unavailable}
            inherited={props.inherited}
            defaultMode={props.defaultMode}
            onChange={props.onChange}
          />
        </Suspense>
      </MenuContent>
    </Menu>
  );
}
