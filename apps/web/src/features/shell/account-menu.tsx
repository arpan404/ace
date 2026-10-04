import { useConnectionState } from "@ace/client-react";
import { UserIcon } from "@phosphor-icons/react";
import { initials } from "@ace/ui-core";
import { lazy } from "react";
import { cn } from "@/lib/cn.ts";
import { useProfileName } from "@/lib/profile.ts";
import { Icon } from "@/components/icon.tsx";
import { connectionLabels } from "./connection-labels.ts";
import { SidebarMenu } from "./sidebar-menu.tsx";

const AccountMenuContent = lazy(() =>
  import("./account-menu-content.tsx").then((module) => ({ default: module.AccountMenuContent })),
);

/**
 * The account at the foot of the rail: the person's initials on a neutral disc (a silhouette
 * until they give a name in Settings › General), whose dot is the daemon connection.
 */
export function AccountMenu() {
  const state = useConnectionState();
  const [name] = useProfileName();
  const letters = initials(name);
  const label = connectionLabels[state];
  return (
    <SidebarMenu
      tip="Account and connection"
      trigger={
        <button
          type="button"
          aria-label="Account and connection"
          className="relative grid size-7 place-items-center rounded-full bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-[color,transform] duration-(--dur-1) hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] active:scale-[0.94]"
        >
          {letters ? (
            <span
              aria-hidden
              className="text-[11px] font-semibold tracking-[0.02em] text-foreground"
            >
              {letters}
            </span>
          ) : (
            <Icon icon={UserIcon} size={14} />
          )}
          <span
            role="status"
            aria-label={`Daemon: ${label}`}
            className={cn(
              "absolute -right-px -bottom-px size-[9px] rounded-full shadow-[0_0_0_2px_rgb(var(--rail-rgb))]",
              state === "ready"
                ? "bg-status-done"
                : "bg-rail shadow-[inset_0_0_0_1.5px_var(--subtle-foreground),0_0_0_2px_rgb(var(--rail-rgb))]",
            )}
          />
        </button>
      }
    >
      <AccountMenuContent from="rail" />
    </SidebarMenu>
  );
}

/** The sidebar's title, "ace ▾": the same menu as the account, opening under it. */
export function WorkspaceMenu() {
  return (
    <SidebarMenu
      trigger={
        <button
          type="button"
          aria-label="ace menu"
          className="flex h-8 items-center gap-1 rounded-md px-1.5 text-lg font-semibold tracking-[-0.01em] text-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-sidebar-accent"
        >
          ace
          {/* A small chevron drawn here: an icon module would weigh on the first paint. */}
          <svg aria-hidden viewBox="0 0 12 12" className="size-3 text-subtle-foreground">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      }
    >
      <AccountMenuContent from="header" />
    </SidebarMenu>
  );
}
