import { Link, useRouterState } from "@tanstack/react-router";
import { GearSixIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { CountBadge } from "@/components/ui/dot.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { AccountMenu } from "./account-menu.tsx";
import { activeView, railViews, type RailView } from "./views.ts";

/**
 * Slack-style rail of views: icon over label, Settings and the account at the foot. Counts come
 * from the views that own them (Activity's needs-you total), composed in by the app layer.
 */
export function Rail(props: { badges?: Partial<Record<RailView["id"], number>> }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = activeView(pathname);
  return (
    <nav
      aria-label="Views"
      className="vibrancy relative z-[2] flex min-h-0 w-(--rail-w) shrink-0 flex-col items-center border-r border-sidebar-border bg-rail pt-3"
    >
      <ul className="flex w-full flex-col gap-0.5 px-1.5">
        {railViews.map((view) => (
          <li key={view.id}>
            <RailItem
              view={view}
              active={current === view.id}
              badge={props.badges?.[view.id] ?? 0}
            />
          </li>
        ))}
      </ul>
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-1.5 pt-2 pb-3.5">
        <Tip label="Settings" shortcut="settings" side="right">
          <Link
            to="/settings"
            aria-label="Settings"
            className={cn(
              "grid size-[34px] place-items-center rounded-card text-muted-foreground transition-colors duration-(--dur-1) hover:bg-sidebar-accent hover:text-foreground",
              current === "settings" && "text-foreground",
            )}
          >
            <Icon icon={GearSixIcon} size={20} active={current === "settings"} />
          </Link>
        </Tip>
        <AccountMenu />
      </div>
    </nav>
  );
}

function RailItem(props: { view: RailView; active: boolean; badge: number }) {
  const { view, active } = props;
  return (
    <Link
      to={view.to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full flex-col items-center gap-[3px] rounded-card pt-1.5 pb-[5px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:[&>span:first-child]:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_70%,transparent)]",
        active && "text-foreground",
      )}
    >
      <span
        className={cn(
          "grid h-[26px] w-9 place-items-center rounded-[7px] transition-[background-color] duration-(--dur-1) group-hover:bg-sidebar-accent",
          active && "bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)]",
        )}
      >
        <Icon
          icon={view.icon}
          size={20}
          active={active}
          weight={view.id === "more" ? "bold" : undefined}
        />
      </span>
      <span className={cn("text-2xs", active && "font-medium")}>{view.label}</span>
      <CountBadge
        count={props.badge}
        label={`${props.badge} need you`}
        className="absolute top-[3px] right-[9px]"
      />
    </Link>
  );
}
