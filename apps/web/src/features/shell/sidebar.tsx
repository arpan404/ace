import { Link } from "@tanstack/react-router";
import { BotIcon, InboxIcon, SettingsIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ThreadLink } from "./thread-link.tsx";
import { useNeedsYouThreadIds, useWorkspaceGroups } from "./use-threads.ts";

const navLink =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium";

function NavLink(props: {
  to: "/inbox" | "/conductor" | "/accounts" | "/settings";
  icon: ReactNode;
  children: ReactNode;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <Link to={props.to} className={navLink} onClick={props.onNavigate}>
      {props.icon}
      {props.children}
    </Link>
  );
}

export function SidebarContent(props: { onNavigate?: () => void }) {
  const needsYou = useNeedsYouThreadIds().length;
  const groups = useWorkspaceGroups();
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-2">
      <nav aria-label="Primary" className="flex flex-col gap-0.5">
        <NavLink to="/inbox" icon={<InboxIcon className="size-4" />} onNavigate={props.onNavigate}>
          <span className="flex-1">Inbox</span>
          {needsYou > 0 && (
            <span className="rounded-full bg-status-needs-you-surface px-1.5 text-xs text-status-needs-you">
              {needsYou}
              <span className="sr-only"> need you</span>
            </span>
          )}
        </NavLink>
        <NavLink
          to="/conductor"
          icon={<BotIcon className="size-4" />}
          onNavigate={props.onNavigate}
        >
          Conductor
        </NavLink>
        <NavLink
          to="/accounts"
          icon={<UsersIcon className="size-4" />}
          onNavigate={props.onNavigate}
        >
          Accounts
        </NavLink>
        <NavLink
          to="/settings"
          icon={<SettingsIcon className="size-4" />}
          onNavigate={props.onNavigate}
        >
          Settings
        </NavLink>
      </nav>
      <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {groups.map((group) => (
          <section key={group.workspaceId} aria-labelledby={`ws-${group.workspaceId}`}>
            <h2
              id={`ws-${group.workspaceId}`}
              className="px-2 pb-1 text-xs font-medium text-muted-foreground"
            >
              {group.workspaceId}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {group.threadIds.map((id) => (
                <li key={id}>
                  <ThreadLink threadId={id} onNavigate={props.onNavigate} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </div>
  );
}
