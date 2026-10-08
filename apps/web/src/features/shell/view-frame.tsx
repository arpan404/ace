import { createPortal } from "react-dom";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSidebarInline } from "@/lib/breakpoints.ts";
import { cn } from "@/lib/cn.ts";
import { Screen } from "./screen.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";

interface ViewList {
  label: string;
  sidebar: ReactNode;
  /** A page is showing the list itself, so the sidebar leaves it out. */
  setInPage(inPage: boolean): void;
}
const ViewListContext = createContext<ViewList | null>(null);
/** The list is drawn as a pane beside its column, so its heading lines up with the column's title. */
const InPaneContext = createContext(false);

/**
 * Where a view's own list goes. `threads`: the view is the thread list the sidebar always shows
 * (Home, and pages that keep it, like Usage & accounts). `sidebar`: the list takes the sidebar's
 * body in its place (Settings' pages). `pane`: the sidebar keeps the threads and the list is a
 * pane at the start of the view's column (Offshifts, Automations, Skills, Activity).
 */
export type ViewListPlace = "threads" | "sidebar" | "pane";

/**
 * A view: its own list (`place`) and its main column. On a narrow window, where the sidebar is a
 * sheet, the view's index page may show the list itself (`ViewListPage`), and a pane isn't drawn.
 */
export function ViewFrame(props: {
  label: string;
  /** The view's list; a `threads` view's is the thread list, shown as a page on a phone. */
  sidebar?: ReactNode;
  place: ViewListPlace;
  children: ReactNode;
}) {
  const { body, claimBody } = useViewFrame();
  const wide = useSidebarInline();
  const [inPage, setInPage] = useState(false);
  const list = useMemo<ViewList>(
    () => ({ label: props.label, sidebar: props.sidebar, setInPage }),
    [props.label, props.sidebar],
  );
  const inSidebar = props.place === "sidebar" && !inPage;
  // The thread list steps out of the sidebar's body while this list is in it.
  useLayoutEffect(() => (inSidebar ? claimBody() : undefined), [inSidebar, claimBody]);
  return (
    <ViewListContext.Provider value={list}>
      {inSidebar &&
        body &&
        createPortal(
          <aside aria-label={props.label} className="flex min-h-0 flex-1 flex-col">
            {props.sidebar}
          </aside>,
          body,
        )}
      <div className="relative flex min-w-0 flex-1 bg-reading">
        {props.place === "pane" && wide && (
          <aside
            aria-label={props.label}
            className="flex w-(--pane-w) min-h-0 shrink-0 flex-col border-r"
          >
            <InPaneContext.Provider value>{props.sidebar}</InPaneContext.Provider>
          </aside>
        )}
        <div className="relative flex min-w-0 flex-1 flex-col">{props.children}</div>
      </div>
    </ViewListContext.Provider>
  );
}

/**
 * A view's index page. On a narrow window, where the sidebar is a sheet, the list is the page:
 * tapping Home (or Offshifts, Skills…) shows its list, and a row opens the item. On a wide window
 * the list is already on screen, so `fallback` shows (usually a redirect to the first item).
 */
export function ViewListPage(props: { title: string; fallback: ReactNode }) {
  const wide = useSidebarInline();
  const list = useContext(ViewListContext);
  const setInPage = list?.setInPage;
  useLayoutEffect(() => {
    if (wide || !setInPage) return;
    setInPage(true);
    return () => setInPage(false);
  }, [wide, setInPage]);
  if (wide || !list) return props.fallback;
  return (
    <Screen title={props.title}>
      <aside
        aria-label={list.label}
        className="mx-auto flex h-full w-full max-w-(--column) min-h-0 flex-col"
      >
        {list.sidebar}
      </aside>
    </Screen>
  );
}

/** The heading of a view's list in the sidebar, with an optional filter or actions. */
export function SidebarHeader(props: { title: string; actions?: ReactNode }) {
  const inPane = useContext(InPaneContext);
  return (
    <div
      className={cn(
        "group/heading flex shrink-0 items-center gap-1.5 pr-2.5 pl-4",
        // Beside a column, the heading takes the header's height so both titles share a line.
        inPane ? "h-(--header-h)" : "h-10 pt-1",
      )}
    >
      <h2 className="min-w-0 flex-1 truncate text-ui text-muted-foreground">{props.title}</h2>
      {props.actions}
    </div>
  );
}

/** Heading plus a scrolling body: the common layout of a view's list. */
export function ViewSidebar(props: {
  title: string;
  actions?: ReactNode;
  /** Fixed rows under the heading (tabs, search). */
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <SidebarHeader title={props.title} actions={props.actions} />
      {props.toolbar}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{props.children}</div>
    </>
  );
}
