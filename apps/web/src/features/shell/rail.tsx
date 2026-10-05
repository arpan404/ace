import { Link, useRouterState } from "@tanstack/react-router";
import { DotsThreeIcon, GearSixIcon } from "@phosphor-icons/react";
import { useSidebarStore } from "@ace/client-react";
import { AttentionTally, entryAttention, firstLaunch, type Attention } from "@ace/ui-core";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { CountBadge } from "@/components/ui/dot.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { AccountMenu } from "./account-menu.tsx";
import { SidebarMenu } from "./sidebar-menu.tsx";
import { activeView, railViews, type RailView, type View } from "./views.ts";

const square =
  "relative grid size-8 place-items-center rounded-lg text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-sidebar-accent";
const selected = "bg-ring/10 text-link";

/**
 * The rail of views: icons only, each named by its tooltip with its shortcut. Home carries a
 * dot while a thread needs you or has news; Activity its needs-you count. More is a menu of the
 * less used places; Settings and the account sit at the foot.
 */
export function Rail(props: {
  /** Counts the views own (Activity's needs-you total), composed in by the app layer. */
  badges?: Partial<Record<View["id"], number>>;
  /** What More holds (the More slice's menu contents), composed in by the app layer. */
  moreMenu: ReactNode;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = activeView(pathname);
  const attention = useHomeAttention();
  return (
    <nav
      aria-label="Views"
      data-slot="rail"
      className="vibrancy relative z-[2] flex w-(--rail-w) shrink-0 flex-col items-center border-r border-sidebar-border bg-rail pt-[9px] pb-3 [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag]"
    >
      <ul className="flex flex-col items-center gap-1.5">
        {railViews.map((view) => (
          <li key={view.id}>
            <RailLink
              view={view}
              active={current === view.id}
              badge={props.badges?.[view.id] ?? 0}
              dot={view.id === "home" ? attention : undefined}
            />
          </li>
        ))}
        <li>
          <SidebarMenu
            tip="More"
            trigger={
              <button
                type="button"
                aria-label="More"
                className={cn(square, current === "more" && selected)}
              >
                <Icon icon={DotsThreeIcon} size={18} weight="bold" />
              </button>
            }
          >
            {props.moreMenu}
          </SidebarMenu>
        </li>
      </ul>
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-2.5">
        <Tip label="Settings" shortcut="settings" side="right">
          <Link
            to="/settings"
            aria-label="Settings"
            aria-current={current === "settings" ? "page" : undefined}
            className={cn(square, current === "settings" && selected)}
          >
            <Icon icon={GearSixIcon} size={18} active={current === "settings"} />
          </Link>
        </Tip>
        <AccountMenu />
      </div>
    </nav>
  );
}

const dotWords = { "needs-you": "a thread needs you", unread: "new activity" } as const;

function RailLink(props: {
  view: RailView;
  active: boolean;
  badge: number;
  dot: "needs-you" | "unread" | undefined;
}) {
  const { view, active, badge, dot } = props;
  const count = `${badge} need you`;
  const name =
    badge > 0 ? `${view.label}, ${count}` : dot ? `${view.label}, ${dotWords[dot]}` : view.label;
  return (
    <Tip label={view.label} side="right" {...(view.shortcut ? { shortcut: view.shortcut } : {})}>
      <Link
        to={view.to}
        aria-label={name}
        aria-current={active ? "page" : undefined}
        className={cn(square, active && selected)}
      >
        <Icon icon={view.icon} size={18} active={active} />
        <CountBadge count={badge} label={count} className="absolute -top-0.5 -right-1" />
        {dot && (
          <span
            aria-hidden
            className={cn(
              "absolute top-1 right-1 size-[7px] rounded-full shadow-[0_0_0_2px_var(--rail)]",
              dot === "needs-you" ? "bg-status-needs-you" : "bg-ring",
            )}
          />
        )}
      </Link>
    </Tip>
  );
}

/**
 * Home's dot, kept as counts: each change re-reads only the threads it names (`thread:<id>`),
 * and a fresh snapshot re-reads them all once. Unread is judged against this device's first
 * launch, the same moment Home's list uses.
 */
function useHomeAttention(): Attention {
  const store = useSidebarStore();
  const { storage } = useLayout();
  // The first launch, recorded now if nothing has asked yet.
  const [baseline] = useState(() => firstLaunch(storage, Date.now()));
  const [tally] = useState(() => new AttentionTally());
  const subscribe = useCallback(
    (notify: () => void) => {
      tally.clear();
      if (!store) return () => {};
      const readAll = () => {
        tally.clear();
        for (const id of store.ids) tally.set(id, entryAttention(store.thread(id), baseline));
      };
      readAll();
      return store.observe((keys) => {
        const before = tally.value;
        if (keys === "all") readAll();
        else
          for (const key of keys)
            if (key.startsWith("thread:")) {
              const id = key.slice("thread:".length);
              tally.set(id, entryAttention(store.thread(id), baseline));
            }
        if (tally.value !== before) notify();
      });
    },
    [store, tally, baseline],
  );
  return useSyncExternalStore(subscribe, () => tally.value);
}
