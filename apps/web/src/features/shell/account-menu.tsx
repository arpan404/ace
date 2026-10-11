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
/**
 * The profile at the foot of the sidebar, its full width: the person's initials on a neutral disc
 * (a silhouette until they give a name in Settings › General) and their name. The disc's dot is
 * the daemon connection, said in words under the name while it isn't connected. The connection is
 * part of the button's name rather than a live region, so a flapping connection isn't read out
 * each time. Its menu is the only way to Usage.
 */
export function AccountMenu() {
  const state = useConnectionState();
  const [name] = useProfileName();
  const letters = initials(name);
  const shown = name.trim() || "You";
  const label =
    state === "ready"
      ? `${shown}, account`
      : `${shown}, account, ace ${connectionLabels[state].toLowerCase()}`;
  return (
    <SidebarMenu
      trigger={
        <button
          type="button"
          aria-label={label}
          className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 text-left transition-colors duration-(--dur-1) focus-ring hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent pointer-coarse:h-11"
        >
          <span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
            {letters ? (
              <span
                aria-hidden
                className="text-2xs font-semibold tracking-[0.02em] text-foreground"
              >
                {letters}
              </span>
            ) : (
              <Icon icon={UserIcon} size={14} />
            )}
            <span
              aria-hidden
              data-state={state}
              className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-sidebar"
            >
              <span className={cn("size-[9px] rounded-full", connectionDot[state])} />
            </span>
          </span>
          <span aria-hidden className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-ui font-medium text-foreground">{shown}</span>
          </span>
        </button>
      }
    >
      <AccountMenuContent />
    </SidebarMenu>
  );
}
