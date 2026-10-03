import {
  CaretLeftIcon,
  CaretRightIcon,
  DotsThreeIcon,
  SidebarSimpleIcon,
  SquareHalfBottomIcon,
  SquareSplitHorizontalIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { usePhone, useSidebarInline } from "@/lib/breakpoints.ts";
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
  const wide = useSidebarInline();
  // A phone keeps one ⋯ for the title menu and the actions, and leaves history to the system.
  const phone = usePhone();
  return (
    <header
      className={cn(
        "relative z-[7] flex h-(--header-h) shrink-0 items-center gap-1 border-b border-transparent pr-2.5 pl-3 transition-[border-color] duration-(--dur-2) [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]",
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
      {!phone && (
        <>
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
        </>
      )}
      <div className="ml-1.5 flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-[-0.005em]">
          {props.title}
        </h1>
        {props.subtitle && (
          <span className="hidden shrink-0 truncate text-base font-normal text-muted-foreground md:inline">
            {props.subtitle}
          </span>
        )}
        {props.menu && !phone && (
          <Menu>
            <MenuTrigger
              render={<IconButton icon={DotsThreeIcon} label="More actions" size="sm" />}
            />
            <MenuContent>{props.menu}</MenuContent>
          </Menu>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {props.actions && wide && props.actions}
        {/* Narrower, the actions (and on a phone the title menu) fold into one ⋯. */}
        {(props.actions || props.menu) && !wide && (
          <Overflow actions={props.actions} menu={phone ? props.menu : undefined} />
        )}
        {hasPanels && (
          <>
            {props.actions && wide && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
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

/**
 * The folded header: the actions in a row, then the title menu behind one more tap. One ⋯ in
 * the header, so the title keeps the room.
 */
function Overflow(props: { actions: ReactNode; menu: ReactNode }) {
  if (!props.actions && props.menu)
    return (
      <Menu>
        <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="More actions" />} />
        <MenuContent align="end">{props.menu}</MenuContent>
      </Menu>
    );
  return (
    <Popover>
      <PopoverTrigger render={<IconButton icon={DotsThreeIcon} label="More actions" />} />
      <PopoverContent
        align="end"
        className="flex max-w-[calc(100vw-1.5rem)] flex-col gap-1.5 p-1.5"
      >
        {props.actions && (
          <div className="flex flex-wrap items-center gap-1.5">{props.actions}</div>
        )}
        {props.actions && props.menu && <span aria-hidden className="-mx-1.5 h-px bg-border" />}
        {props.menu && (
          <Menu>
            <MenuTrigger className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent aria-expanded:bg-accent">
              <DotsThreeIcon aria-hidden size={16} />
              More options
            </MenuTrigger>
            <MenuContent align="end">{props.menu}</MenuContent>
          </Menu>
        )}
      </PopoverContent>
    </Popover>
  );
}
