import {
  CaretLeftIcon,
  CaretRightIcon,
  DotsThreeIcon,
  SidebarSimpleIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { usePhone, useSidebarInline } from "@/lib/breakpoints.ts";
import { useHistoryNav } from "@/lib/history-nav.ts";
import { useViewFrame } from "./view-frame.tsx";

export interface HeaderProps {
  /** 14px semibold. Rendered as the view's h1. */
  title: ReactNode;
  /** Muted beside the title: the project on a thread, the page in Settings. */
  subtitle?: ReactNode;
  /** Items for the ⋯ menu beside the title. */
  menu?: ReactNode;
  /** After the ⋯ menu: a toggle for the screen's summary (a thread's outline). */
  summary?: ReactNode;
  /** Right-hand actions (Run, Open, Commit, Mark all read, …). */
  actions?: ReactNode;
}

/**
 * The sidebar toggle, then history back and forward: always the first controls of the window's
 * top row, in the same place whether the sidebar shows or not (and in full view, where the
 * side panel's strip carries them).
 */
export function HeaderNav() {
  const frame = useViewFrame();
  const nav = useHistoryNav();
  // A phone leaves history to the system.
  const phone = usePhone();
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      {frame.hasSidebar && (
        <IconButton
          icon={SidebarSimpleIcon}
          label={frame.sidebarShown ? "Hide sidebar" : "Show sidebar"}
          shortcut="toggleSidebar"
          onClick={frame.sidebarShown ? frame.hideSidebar : frame.showSidebar}
        />
      )}
      {!phone && (
        <>
          <IconButton
            icon={CaretLeftIcon}
            label="Back"
            shortcut="back"
            disabled={!nav.canGoBack}
            onClick={nav.back}
          />
          <IconButton
            icon={CaretRightIcon}
            label="Forward"
            shortcut="forward"
            disabled={!nav.canGoForward}
            onClick={nav.forward}
          />
        </>
      )}
    </div>
  );
}

/**
 * The one header every screen uses: sidebar toggle and history, then the title, its project,
 * the ⋯ menu and the summary; actions and the dock toggles on the right. 50px, a drag region in
 * Electron, hairline only once the content scrolls. Every control is a 30px box on one centre
 * line.
 */
export function AppHeader(
  props: HeaderProps & {
    scrolled: boolean;
    /** The far-right cluster: the dock toggles, while the side panel isn't showing beside it. */
    trailing?: ReactNode;
  },
) {
  const wide = useSidebarInline();
  // A phone keeps one ⋯ for the title menu and the actions.
  const phone = usePhone();
  return (
    // A container: beside an open side panel the column can be narrow, and below 720px the
    // actions drop their labels (they stay their accessible names) so the title keeps its room.
    <header
      className={cn(
        // The hairline is an inset shadow, not a border, so the 50px row keeps its exact centre.
        "@container/header relative z-[7] flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-3 shadow-[inset_0_-1px_0_transparent] transition-shadow duration-(--dur-2) [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]",
        props.scrolled && "shadow-[inset_0_-1px_0_var(--border)]",
      )}
    >
      <HeaderNav />
      <div className="ml-1.5 flex min-w-0 flex-1 items-center gap-2">
        <h1 className="min-w-0 truncate text-base font-semibold tracking-[-0.005em]">
          {props.title}
        </h1>
        {props.subtitle && (
          // The title keeps the room: a long subtitle (a Deck lane's branch) truncates first.
          <span className="hidden min-w-0 shrink-[3] truncate text-base font-normal text-muted-foreground md:inline @max-[45rem]/header:hidden">
            {props.subtitle}
          </span>
        )}
        {(props.menu || props.summary) && (
          <span className="flex shrink-0 items-center gap-0.5">
            {props.menu && !phone && (
              <Menu>
                <MenuTrigger render={<IconButton icon={DotsThreeIcon} label="More actions" />} />
                <MenuContent>{props.menu}</MenuContent>
              </Menu>
            )}
            {props.summary}
          </span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {props.actions && wide && props.actions}
        {/* Narrower, the actions (and on a phone the title menu) fold into one ⋯. */}
        {(props.actions || props.menu) && !wide && (
          <Overflow actions={props.actions} menu={phone ? props.menu : undefined} />
        )}
        {props.trailing && (
          <>
            {props.actions && wide && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
            {props.trailing}
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
