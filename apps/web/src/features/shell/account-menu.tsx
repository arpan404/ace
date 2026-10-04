import { useConnectionState } from "@ace/client-react";
import { UserIcon } from "@phosphor-icons/react";
import { initials } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useProfileName } from "@/lib/profile.ts";
import { Icon } from "@/components/icon.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { lazy } from "react";
import { connectionLabels } from "./connection-labels.ts";
import { SidebarMenu } from "./sidebar-menu.tsx";

const AccountMenuContent = lazy(() =>
  import("./account-menu-content.tsx").then((module) => ({ default: module.AccountMenuContent })),
);

/**
 * The account at the foot of the sidebar: the person's initials on a neutral disc (a silhouette
 * until they give a name in Settings › General), whose dot is the daemon connection. Full width
 * it also says who and how the connection is; `compact`, it is the disc alone.
 */
export function AccountMenu(props: { compact: boolean }) {
  const state = useConnectionState();
  const [name] = useProfileName();
  const letters = initials(name);
  const connection = useDaemonConnection();
  const label = connectionLabels[state];
  const { compact } = props;
  return (
    <SidebarMenu
      trigger={
        <button
          type="button"
          aria-label="Account and connection"
          className={cn(
            "outline-none transition-[color,background-color,transform] duration-(--dur-1)",
            compact
              ? "mt-0.5 rounded-full hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] active:scale-[0.94]"
              : "flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 text-left hover:bg-sidebar-accent focus-visible:bg-sidebar-accent aria-expanded:bg-sidebar-accent",
          )}
        >
          <span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
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
                "absolute -right-px -bottom-px size-[9px] rounded-full shadow-[0_0_0_2px_rgb(var(--sidebar-rgb))]",
                state === "ready"
                  ? "bg-status-done"
                  : "bg-sidebar shadow-[inset_0_0_0_1.5px_var(--subtle-foreground),0_0_0_2px_rgb(var(--sidebar-rgb))]",
              )}
            />
          </span>
          {!compact && (
            <span aria-hidden className="min-w-0 flex-1 leading-[1.25]">
              <span className="block truncate text-ui font-medium text-foreground">
                {name || (connection.mode === "fake" ? "Fake daemon" : "Daemon")}
              </span>
              <span className="block truncate text-xs text-subtle-foreground">{label}</span>
            </span>
          )}
        </button>
      }
    >
      <AccountMenuContent compact={compact} />
    </SidebarMenu>
  );
}
