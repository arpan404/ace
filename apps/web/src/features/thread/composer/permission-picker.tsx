import { PermissionClient } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { PermissionCapabilities, PermissionMode, ProviderKind } from "@ace/protocol";
import { permissionCoverage, permissionLabel, permissionNeedsAttention } from "@ace/ui-core";
import { ShieldCheckIcon } from "@phosphor-icons/react";
import { Suspense } from "react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useComposerCompact } from "./composer-compact.ts";
import { chipControl } from "./composer-styles.ts";
import { DeferredPermissionMenu, MenuPending } from "./deferred-menus.tsx";
import { permissionIcons } from "./permission-icons.ts";

/**
 * What a provider can gate in each permission mode (`permissions.capabilities`), for a thread
 * that doesn't exist yet or one whose live capabilities haven't arrived. `live` wins.
 */
export function usePermissionCapabilities(
  provider: ProviderKind | undefined,
  live?: PermissionCapabilities | undefined,
): { capabilities: PermissionCapabilities | undefined; loading: boolean; failed: boolean } {
  const query = useDaemonQuery({
    queryKey: ["permissions", "capabilities", provider],
    enabled: !!provider && !live,
    staleTime: 5 * 60_000,
    read: async (client, signal) => {
      if (!provider) return undefined;
      const reply = await new PermissionClient(client).getCapabilities(provider, undefined, {
        signal,
      });
      if (!reply.ok) throw new Error(reply.error ?? "unavailable");
      return reply.permissions;
    },
  });
  if (live) return { capabilities: live, loading: false, failed: false };
  return {
    capabilities: query.data,
    loading: !!provider && query.data === undefined && !query.isError,
    failed: query.isError,
  };
}

/** Set a thread's own mode, or `null` to follow the project and global default again. */
export function useSetThreadPermission(threadId: string) {
  const client = useClient();
  return async (mode: PermissionMode | null) => {
    const result = await new PermissionClient(client).setThread(threadId, mode);
    if (!result.ok) throw new Error(result.error ?? "refused");
  };
}

/**
 * How the agent's actions get approved: a quiet chip in the composer's footer with the mode's
 * icon and name (icon only when the composer is narrow), and the provider's real coverage in
 * its tooltip and menu. Full access is the one mode drawn in the attention colour.
 */
export function PermissionPicker(props: {
  mode: PermissionMode | undefined;
  capabilities: PermissionCapabilities | undefined;
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
  const compact = useComposerCompact();
  const label = mode ? permissionLabel(mode) : props.loading ? "Approvals…" : "Approvals";
  const Glyph = mode ? permissionIcons[mode] : ShieldCheckIcon;
  const attention = !!mode && permissionNeedsAttention(mode);
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
          className={cn(
            chipControl,
            attention && "text-status-needs-you hover:text-status-needs-you",
          )}
        >
          <Glyph aria-hidden size={16} weight={attention ? "fill" : "regular"} />
          {!compact && <span className="truncate">{label}</span>}
          {props.pending && (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current opacity-60" />
          )}
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" align="start" className="w-[320px]">
        <Suspense fallback={<MenuPending />}>
          <DeferredPermissionMenu.Component
            mode={mode}
            capabilities={props.capabilities}
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
