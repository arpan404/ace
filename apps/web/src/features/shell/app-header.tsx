import { ArrowLeftIcon, ArrowRightIcon, CaretLeftIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Suspense, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SidebarTrigger } from "@/components/ui/sidebar.tsx";
import { HeaderMenu } from "./sidebar-menu.tsx";
import { usePhone, useSidebarInline } from "@/lib/breakpoints.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { useHistoryNav } from "@/lib/history-nav.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";

export interface HeaderProps {
  /** 13px medium. Rendered as the view's h1. */
  title: ReactNode;
  /**
   * Where the title sits, before it and a "/": a thread's project (badge and name), or the
   * parent thread of a child thread. Muted; dropped first when the header is narrow.
   */
  crumb?: ReactNode;
  /** Muted beside the title: the project on a thread, the page in Settings. */
  subtitle?: ReactNode;
  breadcrumb?: ReactNode;
  /** Items for the header's ⋯ menu, at its right. */
  menu?: ReactNode;
  /** After the ⋯ menu: the screen's own tool buttons. */
  tools?: ReactNode;
  /** Right-hand actions, before the ⋯ menu (Mark all read, …). */
  actions?: ReactNode;
  /** A status mark after the title (a thread's dot), shown on a phone, where no list shows it. */
  status?: ReactNode;
  /** Work in progress on what the screen shows ("Syncing…"), after the title at every width. */
  progress?: ReactNode;
  notice?: ReactNode;
}

/**
 * Back, forward and the sidebar's toggle, as the Codex app places them: at the top of the
 * sidebar while it shows beside the content, at the header's far left while it doesn't.
 * ⌘[ and ⌘] go back and forward; ⌘\ shows or hides the sidebar.
 */
export function NavButtons() {
  const nav = useHistoryNav();
  const frame = useViewFrame();
  return (
    <>
      <IconButton
        icon={ArrowLeftIcon}
        label="Back"
        shortcut="back"
        disabled={!nav.canGoBack}
        onClick={nav.back}
      />
      <IconButton
        icon={ArrowRightIcon}
        label="Forward"
        shortcut="forward"
        disabled={!nav.canGoForward}
        onClick={nav.forward}
      />
      <SidebarTrigger
        label={frame.sidebarShown ? "Hide sidebar" : "Show sidebar"}
        shortcut="toggleSidebar"
      />
    </>
  );
}

/**
 * The header's far left: back, forward and the sidebar toggle while the sidebar isn't beside the
 * content (its top row holds them otherwise). On a phone, the way back to the thread list.
 */
export function HeaderNav() {
  const frame = useViewFrame();
  // A phone leaves history to the system.
  const phone = usePhone();
  if (!frame.hasSidebar) return null;
  if (!phone && frame.sidebarShown && !frame.sheet) return null;
  return (
    // `header-nav`: with no sidebar beside it, the desktop app clears the traffic lights here.
    <div
      data-slot="header-nav"
      className="mr-1.5 flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
    >
      {!phone ? (
        <NavButtons />
      ) : frame.sidebarShown ? (
        <SidebarTrigger label="Hide sidebar" shortcut="toggleSidebar" />
      ) : (
        // A phone's list is the sidebar sheet: going back to it is the header's first control.
        <IconButton
          icon={CaretLeftIcon}
          label="Back to threads"
          shortcut="toggleSidebar"
          onClick={frame.showSidebar}
        />
      )}
    </div>
  );
}

/**
 * The one header every screen uses: sidebar toggle, then the title and its
 * subtitle; on the right the actions, the ⋯ menu, the screen's tools (a thread's Work icon) and
 * the side panel's toggle, with no rule between them. 44px, a drag region in Electron, hairline only once the content scrolls. Every control
 * is a 30px box on one centre line. On a phone it keeps the sidebar toggle, the title (two lines
 * if need be), the status mark, screen tools and one ⋯; the panel toggle moves into that ⋯.
 */
export function AppHeader(
  props: HeaderProps & {
    scrolled: boolean;
    /** The far-right cluster: the panel's toggle, while the panel isn't showing beside it. */
    trailing?: ReactNode;
  },
) {
  const sidebarInline = useSidebarInline();
  const phone = usePhone();
  // The title comes first. Beside an open side panel the header is a container: below 720px
  // the actions drop their labels (they keep their accessible names and shortcut tooltips);
  // only below 420px, or on a phone, do they fold, together with the title menu, into one ⋯.
  const header = useRef<HTMLElement>(null);
  const roomy = useElementSize(header).width >= foldBelow;
  const wide = sidebarInline && roomy && !phone;
  // Folded, the title menu joins the actions behind one ⋯: a header never shows two.
  const folded = !wide && !!props.actions;
  const titleMenu = props.menu && !phone && !folded;
  // Screen tools stay reachable in the header; a phone folds only the panel toggle.
  const tools = phone && props.trailing;
  return (
    <header
      ref={header}
      className={cn(
        // The hairline is drawn with box-shadow, not a border, so the 44px row keeps its exact centre.
        "@container/header relative z-[7] flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-3 shadow-[inset_0_-1px_0_transparent] transition-shadow duration-(--motion-base) [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]",
        props.scrolled && "shadow-[inset_0_-1px_0_var(--border)]",
      )}
    >
      <HeaderNav />
      <div className="ml-1.5 flex min-w-0 flex-1 items-center gap-2">
        {props.crumb && !phone && (
          // The title keeps the room: the crumb truncates first and leaves a narrow header.
          <div className="flex min-w-0 shrink-[3] items-center gap-2 text-ui text-muted-foreground @max-[30rem]/header:hidden">
            <span className="flex min-w-0 items-center gap-1.5 truncate">{props.crumb}</span>
            <span aria-hidden className="text-subtle-foreground">
              /
            </span>
          </div>
        )}
        <div className="min-w-0">
          {props.breadcrumb && (
            <div className="truncate text-xs text-muted-foreground">{props.breadcrumb}</div>
          )}
          {/* A screen still finding its title (a thread loading) has no heading yet, not an empty one. */}
          {props.title !== "" && props.title != null && (
            <h1
              className={cn(
                "min-w-0 text-ui font-medium",
                phone ? "line-clamp-2 leading-[18px] break-words" : "truncate",
              )}
            >
              {props.title}
            </h1>
          )}
        </div>
        {phone && props.status}
        {props.progress}
        {props.subtitle && (
          // The title keeps the room: a long subtitle (a worktree's branch) truncates first.
          <span className="hidden min-w-0 shrink-[3] truncate text-xs font-normal text-muted-foreground md:inline @max-[45rem]/header:hidden">
            {props.subtitle}
          </span>
        )}
      </div>
      {props.notice}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {props.actions && wide && props.actions}
        {titleMenu && (
          <HeaderMenu
            align="end"
            trigger={<IconButton icon={DotsThreeIcon} label="More actions" />}
          >
            {props.menu}
          </HeaderMenu>
        )}
        {/* Narrower, the actions and the title menu fold into one ⋯. */}
        {(folded || (phone && (props.menu || tools))) && (
          <Overflow
            actions={props.actions}
            tools={tools || undefined}
            menu={titleMenu ? undefined : props.menu}
          />
        )}
        {/* Always after the ⋯: [title] [⋯] [tools] [panel toggle]. */}
        {props.tools}
        {props.trailing && !phone && props.trailing}
      </div>
    </header>
  );
}

/**
 * A header narrower than this folds its actions and title menu into one ⋯. Between this and
 * 720px the actions show as icons (`SplitButton`'s `@container/header` rule).
 */
const foldBelow = 420;

/** The folded header's popover: only a narrow header shows one, so its code loads when it does. */
const DeferredOverflow = deferredComponent(() =>
  import("./header-overflow.tsx").then((module) => module.Overflow),
);

/**
 * The folded header: the actions in a row, then the title menu behind one more tap. One ⋯ in
 * the header, so the title keeps the room. Until the popover's code has arrived the ⋯ is a
 * plain button, and a click on it opens the popover once it has.
 */
function Overflow(props: { actions: ReactNode; tools?: ReactNode; menu: ReactNode }) {
  const [wanted, setWanted] = useState(false);
  if (!props.actions && !props.tools && props.menu)
    return (
      <HeaderMenu align="end" trigger={<IconButton icon={DotsThreeIcon} label="More actions" />}>
        {props.menu}
      </HeaderMenu>
    );
  const label = props.menu || props.tools ? "More actions" : "Actions";
  return (
    <Suspense
      fallback={<IconButton icon={DotsThreeIcon} label={label} onClick={() => setWanted(true)} />}
    >
      <DeferredOverflow.Component
        actions={props.actions}
        tools={props.tools}
        menu={props.menu}
        label={label}
        defaultOpen={wanted}
      />
    </Suspense>
  );
}
