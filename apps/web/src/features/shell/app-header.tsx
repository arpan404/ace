import {
  CaretLeftIcon,
  CaretRightIcon,
  DotsThreeIcon,
  SidebarSimpleIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { Suspense, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { HeaderMenu } from "./sidebar-menu.tsx";
import { usePhone, useSidebarInline } from "@/lib/breakpoints.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useHistoryNav } from "@/lib/history-nav.ts";
import { useViewFrame } from "./sidebar-frame.tsx";

export interface HeaderProps {
  /** 14px semibold. Rendered as the view's h1. */
  title: ReactNode;
  /** Muted beside the title: the project on a thread, the page in Settings. */
  subtitle?: ReactNode;
  /** Items for the header's ⋯ menu, at its right. */
  menu?: ReactNode;
  /** After the ⋯ menu: the screen's own tool buttons (a thread's work card). */
  tools?: ReactNode;
  /** Right-hand actions, before the ⋯ menu (Mark all read, …). */
  actions?: ReactNode;
  /** A status mark after the title (a thread's dot), shown on a phone, where no list shows it. */
  status?: ReactNode;
}

/**
 * The sidebar toggle, then history back and forward: always the first controls of the window's
 * top row, in the same place whether the sidebar shows or not (and in full view, where the
 * side panel's strip carries them). On a phone it is one back caret to the list (CMP-7).
 */
export function HeaderNav() {
  const frame = useViewFrame();
  const nav = useHistoryNav();
  // A phone leaves history to the system.
  const phone = usePhone();
  return (
    // `header-nav`: with no sidebar beside it, the desktop app clears the traffic lights here.
    <div
      data-slot="header-nav"
      className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
    >
      {frame.hasSidebar &&
        (phone && !frame.sidebarShown ? (
          // A phone's list is the sidebar sheet: going back to it is the header's first control.
          <IconButton
            icon={CaretLeftIcon}
            label="Back to threads"
            shortcut="toggleSidebar"
            onClick={frame.showSidebar}
          />
        ) : (
          <IconButton
            icon={SidebarSimpleIcon}
            label={frame.sidebarShown ? "Hide sidebar" : "Show sidebar"}
            shortcut="toggleSidebar"
            onClick={frame.sidebarShown ? frame.hideSidebar : frame.showSidebar}
          />
        ))}
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
 * The one header every screen uses: sidebar toggle and history, then the title and its
 * subtitle; on the right the actions, the ⋯ menu, the screen's tools and the side panel's
 * toggle. 50px, a drag region in Electron, hairline only once the content scrolls. Every control
 * is a 30px box on one centre line. On a phone it keeps the sidebar toggle, the title (two lines
 * if need be), the status mark and one ⋯; the tools and the panel's toggle move into that ⋯.
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
  // A phone moves the tools and the panel's toggle into the one ⋯.
  const tools = phone && (props.tools || props.trailing) && (
    <>
      {props.tools}
      {props.trailing}
    </>
  );
  return (
    <header
      ref={header}
      className={cn(
        // The hairline is drawn with box-shadow, not a border, so the 50px row keeps its exact centre.
        "@container/header relative z-[7] flex h-(--header-h) shrink-0 items-center gap-1 pr-2.5 pl-3 shadow-[inset_0_-1px_0_transparent] transition-shadow duration-(--dur-2) [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]",
        props.scrolled && "shadow-[inset_0_-1px_0_var(--border)]",
      )}
    >
      <HeaderNav />
      <div className="ml-1.5 flex min-w-0 flex-1 items-center gap-2">
        <h1
          className={cn(
            "min-w-0 text-base font-semibold tracking-[-0.005em]",
            phone ? "line-clamp-2 leading-[18px] break-words" : "truncate",
          )}
        >
          {props.title}
        </h1>
        {phone && props.status}
        {props.subtitle && (
          // The title keeps the room: a long subtitle (a Deck lane's branch) truncates first.
          <span className="hidden min-w-0 shrink-[3] truncate text-base font-normal text-muted-foreground md:inline @max-[45rem]/header:hidden">
            {props.subtitle}
          </span>
        )}
      </div>
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
        {!phone && props.tools}
        {/* Narrower, the actions and the title menu fold into one ⋯. */}
        {(folded || (phone && (props.menu || tools))) && (
          <Overflow
            actions={props.actions}
            tools={tools || undefined}
            menu={titleMenu ? undefined : props.menu}
          />
        )}
        {props.trailing && !phone && (
          <>
            {(titleMenu || props.tools || (props.actions && wide)) && (
              <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            )}
            {props.trailing}
          </>
        )}
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
