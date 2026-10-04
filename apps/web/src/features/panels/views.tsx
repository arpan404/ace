import type { ComponentType } from "react";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { AgentsTab } from "./agents/agents-tab.tsx";
import { ChangesTab } from "./changes/changes-tab.tsx";
import { PreviewTab } from "./preview/preview-tab.tsx";
import { WithServices } from "./with-services.tsx";

/*
 * The thread's tools as workspace tab views, loaded as one chunk the first time a dock shows one
 * (ADR 0056 route budget). Each adapts an existing tab to `TabViewProps`; the scope is the
 * thread id. Terminals, agent shells and Logs load their own chunks (`terminal/`, `logs/`).
 */

function adapt(
  Tab: ComponentType<{ threadId: string }>,
  needsServices = true,
): ComponentType<TabViewProps> {
  const View = (props: TabViewProps) =>
    needsServices ? (
      <WithServices>
        <Tab threadId={props.scope} />
      </WithServices>
    ) : (
      <Tab threadId={props.scope} />
    );
  return View;
}

/** Changes, scrolled to the file the tab was opened on (`data.path`), if any. */
export function ChangesView(props: TabViewProps) {
  const data = props.tab.data;
  const path =
    typeof data === "object" && data !== null && "path" in data && typeof data.path === "string"
      ? data.path
      : undefined;
  return (
    <WithServices>
      <ChangesTab threadId={props.scope} path={path} />
    </WithServices>
  );
}
/** Preview, reporting its loading to its own tab's strip spinner. */
export function PreviewView(props: TabViewProps) {
  return (
    <WithServices>
      <PreviewTab threadId={props.scope} tabKey={props.tab.key} />
    </WithServices>
  );
}
export const AgentsView = adapt(AgentsTab, false);
