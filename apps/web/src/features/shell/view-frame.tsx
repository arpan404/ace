import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { useViewFrame } from "./sidebar-frame.tsx";

/**
 * A view: its own list, drawn into the body of the one sidebar (the thread list for Home, the
 * feed for Activity, …), and its main column beside it.
 */
export function ViewFrame(props: { label: string; sidebar: ReactNode; children: ReactNode }) {
  const { body } = useViewFrame();
  return (
    <>
      {body &&
        createPortal(
          <aside aria-label={props.label} className="flex min-h-0 flex-1 flex-col">
            {props.sidebar}
          </aside>,
          body,
        )}
      <div className="relative flex min-w-0 flex-1 flex-col bg-reading">{props.children}</div>
    </>
  );
}

/** The heading of a view's list in the sidebar, with an optional filter or actions. */
export function SidebarHeader(props: { title: string; actions?: ReactNode }) {
  return (
    <div className="group/heading flex h-10 shrink-0 items-center gap-1.5 pt-1 pr-2.5 pl-4">
      <h2 className="min-w-0 flex-1 truncate text-ui text-subtle-foreground">{props.title}</h2>
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
