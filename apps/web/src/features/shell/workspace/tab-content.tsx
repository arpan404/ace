import { PuzzlePieceIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  Activity,
  Component,
  createElement,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { WorkspaceDefinition, WorkspaceTab } from "@/lib/workspace/index.ts";

export const tabDomId = (key: string, part: "tab" | "panel") =>
  `ws-${part}-${key.replace(/[^\w-]/g, "_")}`;

/**
 * The views of the side panel's tabs. Each mounts the first time it shows and then stays mounted:
 * hidden ones sit in `<Activity mode="hidden">`, their effects (subscriptions, terminals, GPU
 * views) stopped and updates deferred, and come back as they were left.
 */
export function TabContent(props: {
  scope: string;
  definition: WorkspaceDefinition;
  tabs: readonly WorkspaceTab[];
  shown: string | undefined;
  onClose(key: string): void;
}) {
  return props.tabs.map((tab) => {
    const active = tab.key === props.shown;
    const kind = props.definition.kind(tab.kind);
    return (
      <div
        key={tab.key}
        role="tabpanel"
        id={tabDomId(tab.key, "panel")}
        aria-labelledby={tabDomId(tab.key, "tab")}
        hidden={!active}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <Activity mode={active ? "visible" : "hidden"}>
          {kind ? (
            <TabBoundary
              label={props.definition.title(tab)}
              // Called on every render, so Try again picks up a fresh loader after a failure.
              render={() => (
                <Suspense fallback={kind.Skeleton ? <kind.Skeleton /> : <TabLoading />}>
                  {createElement(kind.view(), { scope: props.scope, tab })}
                </Suspense>
              )}
            />
          ) : (
            <EmptyState
              icon={PuzzlePieceIcon}
              title="This tool isn't available"
              description={`This tab was opened with a tool (“${tab.kind}”) this version of ace doesn't have. Close it, or update ace to bring it back.`}
              action={
                <Button size="sm" variant="outline" onClick={() => props.onClose(tab.key)}>
                  Close tab
                </Button>
              }
            />
          )}
        </Activity>
      </div>
    );
  });
}

export function TabLoading() {
  return (
    <div className="grid h-full place-items-center">
      <Spinner label="Loading" />
    </div>
  );
}

/**
 * A tool whose code failed to load (offline, a new build replaced the chunk) or threw while
 * drawing says so inside its own tab, with Try again; the rest of the workspace keeps working.
 */
class TabBoundary extends Component<
  { label: string; render(): ReactNode },
  { error: Error | undefined }
> {
  override state: { error: Error | undefined } = { error: undefined };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Workspace tab “${this.props.label}” failed`, error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.render();
    return (
      <div role="alert" className="h-full">
        <EmptyState
          icon={WarningCircleIcon}
          title={`${this.props.label} couldn't load`}
          description={`${this.state.error.message}. Check the connection, then try again.`}
          action={
            <Button size="sm" variant="outline" onClick={() => this.setState({ error: undefined })}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
}
