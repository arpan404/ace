import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ChartBarIcon,
  DotsThreeIcon,
  FilesIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { CountBadge } from "@/components/ui/dot.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { activeView, railViews, type RailView } from "./views.ts";

/** The views a phone keeps one tap away; everything else is under More. */
const tabIds: ReadonlySet<RailView["id"]> = new Set(["home", "activity", "deck"]);
const tabs = railViews.filter((view) => tabIds.has(view.id));
const folded = railViews.filter((view) => !tabIds.has(view.id) && view.id !== "more");

const morePages: readonly {
  to: "/more/accounts" | "/more/files" | "/more/search";
  label: string;
  icon: IconGlyph;
}[] = [
  { to: "/more/accounts", label: "Usage & accounts", icon: ChartBarIcon },
  { to: "/more/files", label: "Files", icon: FilesIcon },
  { to: "/more/search", label: "Search", icon: MagnifyingGlassIcon },
];

const item =
  "relative flex h-full w-16 flex-col items-center justify-center gap-[3px] text-2xs text-subtle-foreground outline-none transition-[color,transform] duration-(--dur-1) active:scale-[0.94] focus-visible:text-foreground focus-visible:[&>svg]:rounded-[6px] focus-visible:[&>svg]:shadow-[0_0_0_2px_var(--ring)]";

/**
 * The phone's bottom tab bar (DESIGN-fable.md, phone screens): Home, Activity, Deck and More.
 * More opens the rest of the rail (Automations, Skills), More's pages and Settings.
 */
export function TabBar(props: { badges?: Partial<Record<RailView["id"], number>> }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const current = activeView(pathname);
  const moreActive = current !== undefined && !tabs.some((view) => view.id === current);
  return (
    <nav
      aria-label="Views"
      className="vibrancy relative z-[2] flex h-[calc(56px+env(safe-area-inset-bottom))] shrink-0 justify-around border-t border-sidebar-border bg-rail px-2.5 pb-[env(safe-area-inset-bottom)]"
    >
      {tabs.map((view) => {
        const active = current === view.id;
        const badge = props.badges?.[view.id] ?? 0;
        return (
          <Link
            key={view.id}
            to={view.to}
            aria-current={active ? "page" : undefined}
            className={cn(item, active && "font-medium text-ring")}
          >
            <Icon icon={view.icon} size={20} active={active} />
            {view.label}
            <CountBadge
              count={badge}
              label={`${badge} need you`}
              className="absolute top-1.5 right-3"
            />
          </Link>
        );
      })}
      <Menu>
        <MenuTrigger
          aria-label="More views"
          className={cn(
            item,
            "aria-expanded:text-foreground",
            moreActive && "font-medium text-ring",
          )}
        >
          <Icon icon={DotsThreeIcon} size={20} weight="bold" />
          More
        </MenuTrigger>
        <MenuContent side="top" align="end" sideOffset={8}>
          {folded.map((view) => (
            <MenuItem
              key={view.id}
              icon={<Icon icon={view.icon} />}
              onClick={() => void navigate({ to: view.to })}
            >
              {view.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          {morePages.map((page) => (
            <MenuItem
              key={page.to}
              icon={<Icon icon={page.icon} />}
              onClick={() => void navigate({ to: page.to })}
            >
              {page.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            icon={<Icon icon={GearSixIcon} />}
            onClick={() => void navigate({ to: "/settings" })}
          >
            Settings
          </MenuItem>
        </MenuContent>
      </Menu>
    </nav>
  );
}
