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
import { Screen } from "./screen.tsx";
import { useViewFrame } from "./sidebar-frame.tsx";

interface ViewList {
  label: string;
  sidebar: ReactNode;
  /** A page is showing the list itself, so the sidebar leaves it out. */
  setInPage(inPage: boolean): void;
}
const ViewListContext = createContext<ViewList | null>(null);

/**
 * A view: its own list, drawn into the body of the one sidebar (the thread list for Home, the
 * feed for Activity, …), and its main column beside it. On a narrow window the view's index
 * page may show the list itself (`ViewListPage`).
 */
export function ViewFrame(props: { label: string; sidebar: ReactNode; children: ReactNode }) {
  const { body } = useViewFrame();
  const [inPage, setInPage] = useState(false);
  const list = useMemo<ViewList>(
    () => ({ label: props.label, sidebar: props.sidebar, setInPage }),
    [props.label, props.sidebar],
  );
  return (
    <ViewListContext.Provider value={list}>
      {body &&
        !inPage &&
        createPortal(
          <aside aria-label={props.label} className="flex min-h-0 flex-1 flex-col">
            {props.sidebar}
          </aside>,
          body,
        )}
      <div className="relative flex min-w-0 flex-1 flex-col bg-reading">{props.children}</div>
    </ViewListContext.Provider>
  );
}

/**
 * A view's index page. On a narrow window, where the list lives in a sheet, the list is the
 * page: tapping Home (or Deck, Skills…) shows its list, and a row opens the item. On a wide
 * window the list is already beside the page, so `fallback` shows (usually a redirect to the
 * first item).
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
  return (
    <div className="group/heading flex h-10 shrink-0 items-center gap-1.5 pt-1 pr-2.5 pl-4">
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
