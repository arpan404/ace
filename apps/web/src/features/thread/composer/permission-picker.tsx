import type { PermissionCapabilities, PermissionMode, ProviderKind } from "@ace/protocol";
import {
  permissionCoverage,
  permissionLabel,
  permissionNeedsAttention,
  permissionShortLabel,
} from "@ace/ui-core";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import { Suspense } from "react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { chipControl, iconControl } from "./composer-styles.ts";
import { DeferredPermissionMenu, MenuPending } from "./deferred-menus.tsx";
import { permissionIcons } from "./permission-icons.ts";

/**
 * How the agent's actions get approved: a quiet button in the composer's footer with the mode's
 * icon, alone in the default mode (Auto-review) and with a short name in any other ("Ask",
 * "Read-only", "Full access"); the full name and the provider's real coverage are in the tooltip
 * and menu. Full access is the one mode whose icon is drawn in the attention colour.
 */
export function PermissionPicker(props: {
  mode: PermissionMode | undefined;
  capabilities: PermissionCapabilities | undefined;
  /** Whose modes these are, for the menu's note on what they gate. */
  provider?: ProviderKind | undefined;
  loading: boolean;
  /** Why the mode can't be chosen here, e.g. the daemon couldn't report the provider's modes. */
  unavailable?: string | undefined;
  /** Chosen, waiting for the agent's turn to end. */
  pending?: boolean | undefined;
  /** The mode comes from the default; the menu offers to go back to it. */
  inherited?: boolean | undefined;
  /** A thread's default, offered as "Use the default" when it has its own mode. */
  defaultMode?: PermissionMode | undefined;
  onChange(mode: PermissionMode | null): void;
}) {
  const mode = props.mode;
  const label = mode ? permissionLabel(mode) : props.loading ? "Approvals…" : "Approvals";
  const Glyph = mode ? permissionIcons[mode] : ShieldCheckIcon;
  const attention = !!mode && permissionNeedsAttention(mode);
  const short = mode ? permissionShortLabel(mode) : undefined;
  const tip = [
    mode ? `${label} · ${permissionCoverage(props.capabilities, mode)}` : label,
    props.pending ? "applies after this turn" : undefined,
    props.inherited ? "default" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Menu>
      <Tip label={props.unavailable ?? tip} side="top">
        <MenuTrigger
          aria-label={`Approvals: ${label}${props.pending ? ", applies after this turn" : ""}`}
          className={short ? chipControl : iconControl}
        >
          <Glyph
            aria-hidden
            size={16}
            weight={attention ? "fill" : "regular"}
            className={cn(attention && "text-status-needs-you")}
          />
          {short && <span className="truncate">{short}</span>}
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" align="start" className="w-[320px]">
        <Suspense fallback={<MenuPending />}>
          <DeferredPermissionMenu.Component
            mode={mode}
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
