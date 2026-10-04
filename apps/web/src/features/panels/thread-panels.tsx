import { lazy, Suspense, type ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { PanelDefinition } from "@/features/shell/index.ts";
import { ThreadDiffStat } from "./changes/diff-stat.tsx";
import { PanelServicesContext, useLoadedServices } from "./services.ts";

/*
 * Panels start closed, so their code loads (as one chunk) the first time a panel shows, not
 * with the thread screen (ADR 0056 route budget). Only the Changes badge renders with the tab bar.
 */
const loadTabs = () => import("./tabs.ts");
const ChangesTab = lazy(() => loadTabs().then((m) => ({ default: m.ChangesTab })));
const PreviewTab = lazy(() => loadTabs().then((m) => ({ default: m.PreviewTab })));
const AgentsTab = lazy(() => loadTabs().then((m) => ({ default: m.AgentsTab })));
const TerminalTab = lazy(() => loadTabs().then((m) => ({ default: m.TerminalTab })));
const LogsTab = lazy(() => loadTabs().then((m) => ({ default: m.LogsTab })));
const BottomActions = lazy(() => loadTabs().then((m) => ({ default: m.BottomActions })));
// Devices has a chunk of its own: its channel, frame decoding and device screens load only when
// the tab shows.
const DevicesTab = lazy(() =>
  import("@/features/devices/index.ts").then((m) => ({ default: m.DevicesTab })),
);

function Waiting() {
  return (
    <div className="grid h-full place-items-center">
      <Spinner label="Loading" />
    </div>
  );
}

/**
 * Provides the panel services to a tab, with a spinner while they or the tab's code load.
 * `services: false` is for a tab that needs no services (Agents).
 */
function Loading(props: { children: ReactNode; quiet?: boolean; services?: false }) {
  const services = useLoadedServices();
  const fallback = props.quiet ? null : <Waiting />;
  if (props.services === false) return <Suspense fallback={fallback}>{props.children}</Suspense>;
  if (!services) return fallback;
  return (
    <PanelServicesContext.Provider value={services}>
      <Suspense fallback={fallback}>{props.children}</Suspense>
    </PanelServicesContext.Provider>
  );
}

/**
 * A thread's right panel (Changes · Preview · Devices · Agents) and bottom panel (Terminal · Logs), as
 * data for `<Screen right bottom>`. The shell owns open state, sizes and the panel shortcuts.
 */
export function threadPanels(threadId: string): {
  right: PanelDefinition;
  bottom: PanelDefinition;
} {
  return {
    right: {
      label: "Thread panel",
      tabs: [
        {
          id: "changes",
          label: "Changes",
          badge: <ThreadDiffStat threadId={threadId} />,
          shortcut: "changes",
          content: (
            <Loading>
              <ChangesTab threadId={threadId} />
            </Loading>
          ),
        },
        {
          id: "preview",
          label: "Preview",
          content: (
            <Loading>
              <PreviewTab threadId={threadId} />
            </Loading>
          ),
        },
        {
          id: "devices",
          label: "Devices",
          content: (
            <Loading services={false}>
              <DevicesTab threadId={threadId} />
            </Loading>
          ),
        },
        {
          id: "agents",
          label: "Agents",
          shortcut: "agents",
          content: (
            <Loading services={false}>
              <AgentsTab threadId={threadId} />
            </Loading>
          ),
        },
      ],
    },
    bottom: {
      label: "Bottom panel",
      tabs: [
        {
          id: "terminal",
          label: "Terminal",
          content: (
            <Loading>
              <TerminalTab threadId={threadId} />
            </Loading>
          ),
        },
        {
          id: "logs",
          label: "Logs",
          content: (
            <Loading>
              <LogsTab threadId={threadId} />
            </Loading>
          ),
        },
      ],
      actions: (
        <Loading quiet>
          <BottomActions threadId={threadId} />
        </Loading>
      ),
    },
  };
}
