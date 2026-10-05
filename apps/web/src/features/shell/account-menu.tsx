import { useConnectionState } from "@ace/client-react";
import { UserIcon } from "@phosphor-icons/react";
import { initials } from "@ace/ui-core";
import { lazy } from "react";
import { cn } from "@/lib/cn.ts";
import { useProfileName } from "@/lib/profile.ts";
import { Icon } from "@/components/icon.tsx";
import { connectionDot, connectionLabels } from "./connection-labels.ts";
import { SidebarMenu } from "./sidebar-menu.tsx";

const AccountMenuContent = lazy(() =>
  import("./account-menu-content.tsx").then((module) => ({ default: module.AccountMenuContent })),
);
const DaemonMenuContent = lazy(() =>
  import("./daemon-menu-content.tsx").then((module) => ({ default: module.DaemonMenuContent })),
);

/**
 * The account at the foot of the rail: the person's initials on a neutral disc (a silhouette
 * until they give a name in Settings › General), whose dot is the daemon connection. The
 * connection is part of the button's name rather than a live region, so a flapping connection
 * isn't read out each time.
 */
export function AccountMenu() {
  const state = useConnectionState();
  const [name] = useProfileName();
  const letters = initials(name);
  const label =
    state === "ready"
      ? "Account and connection"
      : `Account and connection, daemon ${connectionLabels[state].toLowerCase()}`;
  return (
    <SidebarMenu
      tip="Account and connection"
      trigger={
        <button
          type="button"
          aria-label={label}
          className="relative grid size-7 place-items-center rounded-full bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-[color,transform] duration-(--dur-1) focus-ring touch-hit touch-hit-lg hover:text-foreground active:scale-[0.94]"
        >
          {letters ? (
            <span aria-hidden className="text-2xs font-semibold tracking-[0.02em] text-foreground">
              {letters}
            </span>
          ) : (
            <Icon icon={UserIcon} size={14} />
          )}
          <span
            aria-hidden
            data-state={state}
            className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-rail"
          >
            <span className={cn("size-[9px] rounded-full", connectionDot[state])} />
          </span>
        </button>
      }
    >
      <AccountMenuContent />
    </SidebarMenu>
  );
}

/** The sidebar's title, "ace ▾": the daemon menu, opening under it. */
export function WorkspaceMenu() {
  return (
    <SidebarMenu
      trigger={
        <button
          type="button"
          aria-label="ace menu"
          className="flex h-8 items-center gap-1 rounded-md px-1.5 text-lg font-semibold tracking-[-0.01em] text-foreground transition-colors duration-(--dur-1) focus-ring hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
        >
          ace
          {/* A small chevron drawn here: an icon module would weigh on the first paint. */}
          <svg aria-hidden viewBox="0 0 12 12" className="size-3 text-subtle-foreground">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      }
    >
      <DaemonMenuContent />
    </SidebarMenu>
  );
}
