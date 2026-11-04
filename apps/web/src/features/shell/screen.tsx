import type { ReactNode } from "react";
import { useOptionalClient } from "@ace/client-react";
import { PausedNotice } from "@/components/paused-notice.tsx";
import { SandboxNotice } from "./sandbox-notice.tsx";
import { useToastAnchor } from "@/lib/toast-clearance.ts";
import type { WorkspaceDefinition } from "@/lib/workspace/index.ts";
import { AppHeader, type HeaderProps } from "./app-header.tsx";
import { canvasClass } from "./canvas.ts";
import { ConnectionNotice } from "./connection-notice.tsx";
import { ConnectionOwner } from "./connection-owner.tsx";
import { Workspace } from "./workspace/workspace.tsx";

/** A screen's side panel: the resources opened beside it, kept per `scope` (a thread's id). */
export interface ScreenWorkspace {
  scope: string;
  definition: WorkspaceDefinition;
  contextPanel?: ReactNode;
}

/**
 * The main column of every route: its part of the window's top bar, then the canvas with the
 * content and, where a screen has a workspace, the side panel beside it. Slices fill `children`
 * and register tab kinds; the frame, keyboard map, persistence and motion are the shell's.
 */
export function Screen(
  props: HeaderProps & {
    workspace?: ScreenWorkspace | undefined;
    children: ReactNode;
  },
) {
  const pane = useToastAnchor();
  // With no machine there is no connection to report on.
  const machine = useOptionalClient() !== undefined;
  const main = (
    <main ref={pane} id="main" tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
      {props.children}
    </main>
  );
  const header = (headerOwnsConnection: boolean) => (trailing?: ReactNode) => (
    <AppHeader
      title={props.title}
      namedByPanel={props.namedByPanel}
      mark={props.mark}
      subtitle={props.subtitle}
      breadcrumb={props.breadcrumb}
      crumb={props.crumb}
      menu={props.menu}
      tools={props.tools}
      actions={props.actions}
      status={props.status}
      progress={props.progress}
      notice={headerOwnsConnection && machine ? <ConnectionNotice /> : null}
      trailing={trailing}
    />
  );
  const workspace = props.workspace;
  // The thread composer's strip claims connection trouble; elsewhere the header says it.
  return (
    <ConnectionOwner>
      {(headerOwnsConnection) =>
        workspace ? (
          <Workspace
            scope={workspace.scope}
            definition={workspace.definition}
            title={props.title}
            header={header(headerOwnsConnection)}
            contextPanel={workspace.contextPanel}
            notice={
              <>
                <PausedNotice />
                <SandboxNotice />
              </>
            }
          >
            {main}
          </Workspace>
        ) : (
          <>
            {header(headerOwnsConnection)()}
            <div className={`${canvasClass} flex-col`}>
              <PausedNotice />
              <SandboxNotice />
              <div className="relative flex min-h-0 flex-1 flex-col">{main}</div>
            </div>
          </>
        )
      }
    </ConnectionOwner>
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
