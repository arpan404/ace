import {
  CaretLeftIcon,
  CaretRightIcon,
  DotsThreeIcon,
  SidebarSimpleIcon,
  SquareHalfBottomIcon,
  SquareSplitHorizontalIcon,
} from "@phosphor-icons/react";
import { cn } from "cn";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { useHistoryNav } from "@/lib/history-nav.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useViewFrame } from "./view-frame.tsx";

export interface HeaderProps {
  /** 14px semibold. Rendered as the view's h1. */
  title: ReactNode;
  /** Muted beside the title: the project on a thread, the page in Settings. */
  subtitle?: ReactNode;
  /** Items for the ⋯ menu beside the title. */
  menu?: ReactNode;
  /** Right-hand actions (Run, Open, Commit, Mark all read, …). */
  actions?: ReactNode;
}

/**
 * The one header every screen uses (Codex desktop): sidebar toggle when hidden, history
 * back and forward, title and ⋯ menu; actions and panel toggles on the right. 50px, a drag
 * region in Electron, hairline only once the content scrolls.
 */
export function AppHeader(
  props: HeaderProps & {
    scrolled: boolean;
    panels: { right: boolean; bottom: boolean };
  },
) {
  const frame = useViewFrame();
  const nav = useHistoryNav();
  const { layout, togglePanel } = useLayout();
  const hasPanels = props.panels.right || props.panels.bottom;
  return (
    <header
      className={cn(
        "relative z-[7] flex h-(--header-h) shrink-0 items-center gap-1 border-b border-transparent pr-2.5 pl-3 transition-[border-color] duration-200 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]",
        props.scrolled && "border-border",
      )}
    >
      {!frame.sidebarShown && (
        <IconButton
          icon={SidebarSimpleIcon}
          label="Show sidebar"
          shortcut="toggleSidebar"
          onClick={frame.showSidebar}
        />
      )}
      <IconButton
        icon={CaretLeftIcon}
        label="Back"
        shortcut="back"
        size="sm"
        disabled={!nav.canGoBack}
        onClick={nav.back}
      />
      <IconButton
        icon={CaretRightIcon}
        label="Forward"
        shortcut="forward"
        size="sm"
        disabled={!nav.canGoForward}
        onClick={nav.forward}
      />
      <div className="ml-1.5 flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-[-0.005em]">
          {props.title}
        </h1>
        {props.subtitle && (
          <span className="shrink-0 truncate text-base font-normal text-muted-foreground">
            {props.subtitle}
          </span>
        )}
        {props.menu && (
          <Menu>
            <MenuTrigger
              render={<IconButton icon={DotsThreeIcon} label="More actions" size="sm" />}
            />
            <MenuContent>{props.menu}</MenuContent>
          </Menu>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {props.actions}
        {hasPanels && (
          <>
            {props.actions && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
            {props.panels.bottom && (
              <IconButton
                icon={SquareHalfBottomIcon}
                label="Bottom panel"
                shortcut="bottomPanel"
                pressed={layout.bottom.open}
                onClick={() => togglePanel("bottom")}
              />
            )}
            {props.panels.right && (
              <IconButton
                icon={SquareSplitHorizontalIcon}
                label="Right panel"
                pressed={layout.right.open}
                onClick={() => togglePanel("right")}
              />
            )}
          </>
        )}
      </div>
    </header>
  );
}
