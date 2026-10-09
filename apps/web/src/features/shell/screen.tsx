import { useState } from "react";
import type { ReactNode, UIEvent } from "react";
import { PausedNotice } from "@/components/paused-notice.tsx";
import type { WorkspaceDefinition } from "@/lib/workspace/index.ts";
import { AppHeader, type HeaderProps } from "./app-header.tsx";
import { ConnectionNotice } from "./connection-notice.tsx";
import { Workspace } from "./workspace/workspace.tsx";

/** A screen's side panel: the resources opened beside it, kept per `scope` (a thread's id). */
export interface ScreenWorkspace {
  scope: string;
  definition: WorkspaceDefinition;
  contextPanel?: ReactNode;
}

/**
 * The main column of every route: the shared header, the content and, where a screen has a
 * workspace, the side panel beside it. Slices fill `children` and register tab kinds; the
 * frame, keyboard map, persistence and motion are the shell's.
 */
export function Screen(
  props: HeaderProps & {
    workspace?: ScreenWorkspace | undefined;
    children: ReactNode;
  },
) {
  const [scrolled, setScrolled] = useState(false);
  // Any scroller inside the content draws the header hairline once it leaves the top.
  const onScroll = (event: UIEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement) setScrolled(target.scrollTop > 0);
  };
  const main = (
    <main
      id="main"
      tabIndex={-1}
      onScrollCapture={onScroll}
      className="relative min-h-0 flex-1 outline-none"
    >
      {props.children}
    </main>
  );
  const header = (trailing?: ReactNode) => (
    <AppHeader
      title={props.title}
      subtitle={props.subtitle}
      breadcrumb={props.breadcrumb}
      menu={props.menu}
      tools={props.tools}
      actions={props.actions}
      status={props.status}
      scrolled={scrolled}
      trailing={trailing}
    />
  );
  if (!props.workspace)
    return (
      <>
        {header()}
        <PausedNotice />
        <ConnectionNotice />
        <div className="relative flex min-h-0 flex-1 flex-col">{main}</div>
      </>
    );
  return (
    <Workspace
      scope={props.workspace.scope}
      definition={props.workspace.definition}
      title={props.title}
      header={header}
      contextPanel={props.workspace.contextPanel}
      notice={
        <>
          <PausedNotice />
          <ConnectionNotice />
        </>
      }
    >
      {main}
    </Workspace>
  );
}

/** Scrollable page body: centred column, 44px top and 32px side padding. */
export function Page(props: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-auto">
      <div
        className={
          props.wide
            ? "mx-auto max-w-[1040px] px-8 pt-11 pb-20"
            : "mx-auto max-w-(--column) px-8 pt-11 pb-20"
        }
      >
        {props.children}
      </div>
    </div>
  );
}

/** Page title (22/600) with an optional lede, for pages without a list-detail layout. */
export function PageTitle(props: { title: string; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-2xl font-semibold tracking-title">{props.title}</h2>
        {props.lede && (
          <p className="mt-1 max-w-[62ch] text-base leading-normal text-muted-foreground">
            {props.lede}
          </p>
        )}
      </div>
      {props.actions}
    </div>
  );
}
