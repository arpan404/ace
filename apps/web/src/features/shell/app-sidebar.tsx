import { Link, useRouterState } from "@tanstack/react-router";
import {
  CaretRightIcon,
  DotsThreeIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import { useRef, type ReactElement } from "react";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { KeymapId } from "@/lib/keymap.ts";
import { Icon } from "@/components/icon.tsx";
import { CountBadge } from "@/components/ui/dot.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { AccountMenu } from "./account-menu.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";
import { SidebarMenu } from "./sidebar-menu.tsx";
import { activeView, sidebarViews, type SidebarView, type View } from "./views.ts";

/** A full-width sidebar row: New thread, the views, More. */
const row =
  "mx-2 flex h-8 shrink-0 items-center gap-[9px] rounded-md px-2.5 text-ui text-sidebar-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent focus-visible:bg-sidebar-accent aria-expanded:bg-sidebar-accent [&_svg]:text-muted-foreground";
/** A square in the column of icons. */
const square =
  "relative grid size-[34px] place-items-center rounded-card text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent hover:text-foreground focus-visible:bg-sidebar-accent aria-expanded:bg-sidebar-accent";
const selected = "bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)] text-foreground";
const look = (icons: boolean, active: boolean) =>
  icons
    ? cn(square, active && selected)
    : cn(row, active && cn(selected, "font-medium [&_svg]:text-foreground"));

/**
 * The one sidebar (as in desktop chat apps): New thread and Search, the views with Activity's
 * needs-you count, the current view's own list as the body (the thread list on Home), and the
 * connection, account and Settings at the foot. Collapsed, it is a column of icons with
 * tooltips; the view's list stays mounted, hidden, so it keeps its scroll.
 */
export function AppSidebar(props: {
  /** Counts the views own (Activity's needs-you total), composed in by the app layer. */
  badges?: Partial<Record<View["id"], number>>;
}) {
  const { collapsed: icons, setBody } = useViewFrame();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = activeView(pathname);
  const { setPaletteOpen } = useLayout();
  const size = icons ? 20 : 16;
  return (
    <>
      <div
        data-slot="sidebar-top"
        className={cn(
          "flex h-(--header-h) w-full shrink-0 items-center [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag]",
          icons ? "justify-center" : "pr-2.5 pl-3.5",
        )}
      >
        <Tip label="Home" shortcut="goHome" side={icons ? "right" : "bottom"}>
          <Link
            to="/"
            aria-label="Home"
            data-slot="sidebar-wordmark"
            className="rounded-md px-1 text-md font-semibold tracking-[-0.01em] text-foreground outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]"
          >
            ace
          </Link>
        </Tip>
      </div>
      <Labelled icons={icons} label="New thread" shortcut="newThread">
        <Link
          to="/new"
          aria-label={icons ? "New thread" : undefined}
          className={icons ? square : cn(row, "mb-1.5 font-medium")}
        >
          <Icon icon={NotePencilIcon} size={size} />
          {!icons && (
            <>
              New thread
              <Kbd keys="mod+n" variant="bare" className="ml-auto" />
            </>
          )}
        </Link>
      </Labelled>
      {icons ? (
        <Tip label="Search" shortcut="palette" side="right">
          <button
            type="button"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
            className={cn(square, "mt-1")}
          >
            <Icon icon={MagnifyingGlassIcon} size={20} />
          </button>
        </Tip>
      ) : (
        <div className="w-full shrink-0 pr-2.5 pb-2 pl-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-full items-center gap-2 rounded-[9px] bg-sidebar-accent pr-2 pl-2.5 text-ui text-subtle-foreground outline-none transition-[background-color,box-shadow] duration-(--dur-1) hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--foreground)_4%)] hover:shadow-[var(--glass-highlight)]"
          >
            <Icon icon={MagnifyingGlassIcon} />
            Search
            <Kbd keys="mod+k" variant="outline" className="ml-auto" />
          </button>
        </div>
      )}
      <nav aria-label="Views" className={cn("shrink-0", icons ? "pt-3" : "w-full pb-1")}>
        <ul className={cn("flex flex-col", icons ? "items-center gap-1" : "gap-px")}>
          {sidebarViews.map((view) => (
            <li key={view.id}>
              <ViewItem
                view={view}
                icons={icons}
                active={current === view.id}
                badge={props.badges?.[view.id] ?? 0}
              />
            </li>
          ))}
          <li className="flex flex-col">
            <SidebarMenu
              menu="more"
              compact={icons}
              tip={icons ? "More" : undefined}
              trigger={
                <button
                  type="button"
                  aria-label={icons ? "More" : undefined}
                  className={look(icons, current === "more")}
                >
                  <Icon icon={DotsThreeIcon} size={size} weight="bold" />
                  {!icons && (
                    <>
                      More
                      <CaretRightIcon aria-hidden size={14} className="ml-auto" />
                    </>
                  )}
                </button>
              }
            />
          </li>
        </ul>
      </nav>
      {/* The current view's list (`ViewFrame`): the only part of the sidebar that scrolls. */}
      <div ref={setBody} hidden={icons} className="flex min-h-0 w-full flex-1 flex-col" />
      {icons && <div className="flex-1" />}
      <Foot icons={icons} settings={current === "settings"} />
    </>
  );
}

/** Full width, the row's text names it; as an icon, a tooltip does, on the right. */
function Labelled(props: {
  icons: boolean;
  label: string;
  shortcut?: KeymapId | undefined;
  children: ReactElement;
}) {
  if (!props.icons) return props.children;
  return (
    <Tip label={props.label} side="right" {...(props.shortcut ? { shortcut: props.shortcut } : {})}>
      {props.children}
    </Tip>
  );
}

function ViewItem(props: { view: SidebarView; icons: boolean; active: boolean; badge: number }) {
  const { view, icons, active, badge } = props;
  const count = `${badge} need you`;
  return (
    <Labelled icons={icons} label={view.label} shortcut={view.shortcut}>
      <Link
        to={view.to}
        aria-current={active ? "page" : undefined}
        aria-label={icons ? (badge > 0 ? `${view.label}, ${count}` : view.label) : undefined}
        className={look(icons, active)}
      >
        <Icon icon={view.icon} size={icons ? 20 : 16} active={active} />
        {!icons && view.label}
        <CountBadge
          count={badge}
          label={count}
          className={icons ? "absolute top-0.5 right-0.5" : "ml-auto"}
        />
      </Link>
    </Labelled>
  );
}

/** The connection and account, Settings, and the switch between full and icons. */
function Foot(props: { icons: boolean; settings: boolean }) {
  const frame = useViewFrame();
  const { icons } = props;
  // The switch moves between the two layouts: keep the keyboard on it when it was pressed.
  const pressed = useRef(false);
  const settings = (
    <Tip label="Settings" shortcut="settings" side={icons ? "right" : "top"}>
      <Link
        to="/settings"
        aria-label="Settings"
        aria-current={props.settings ? "page" : undefined}
        className={cn(square, !icons && "size-[30px] rounded-md", props.settings && selected)}
      >
        <Icon icon={GearSixIcon} size={icons ? 20 : 16} active={props.settings} />
      </Link>
    </Tip>
  );
  const toggle = !frame.sheet && (
    <Tip label={icons ? "Expand sidebar" : "Collapse sidebar"} side={icons ? "right" : "top"}>
      <button
        type="button"
        aria-label={icons ? "Expand sidebar" : "Collapse sidebar"}
        ref={(node) => {
          if (!node || !pressed.current) return;
          pressed.current = false;
          node.focus();
        }}
        onClick={() => {
          pressed.current = true;
          if (icons) frame.expandSidebar();
          else frame.collapseSidebar();
        }}
        className={cn(square, !icons && "size-[30px] rounded-md")}
      >
        <Icon
          icon={CaretRightIcon}
          size={icons ? 20 : 16}
          className={icons ? undefined : "rotate-180"}
        />
      </button>
    </Tip>
  );
  if (icons)
    return (
      <div className="flex flex-col items-center gap-1.5 pt-2 pb-3.5">
        {toggle}
        {settings}
        <AccountMenu compact />
      </div>
    );
  return (
    <div className="flex w-full shrink-0 items-center gap-1 border-t border-sidebar-border px-2 py-2">
      <AccountMenu compact={false} />
      {settings}
      {toggle}
    </div>
  );
}
