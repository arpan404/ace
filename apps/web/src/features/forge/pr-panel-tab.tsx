import { useCallback } from "react";
import type { ForgePrStatus } from "@ace/protocol";
import { pullRequestTab, PullRequestTabData } from "@/features/panels/index.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { usePrWorkspaceExtensions } from "./pr-extension-context.tsx";
import { PrDetail, prWorkspaceTab } from "./pr-detail.tsx";

/** One pull request in a side panel tab; another PR it links to opens in a tab beside it. */
export default function PrPanelTab(props: TabViewProps) {
  const actions = useWorkspaceActions(props.scope);
  const extensions = usePrWorkspaceExtensions();
  const parsed = PullRequestTabData.safeParse(props.tab.data);
  const onState = useCallback(
    (state: ForgePrStatus["state"]) => {
      const identity = PullRequestTabData.safeParse(props.tab.data);
      if (identity.success && identity.data.state !== state)
        actions.update(props.tab.key, { data: { ...identity.data, state } });
    },
    [actions, props.tab.key, props.tab.data],
  );
  if (!parsed.success)
    return (
      <p role="alert" className="p-4 text-sm">
        This pull request tab has an invalid identity. Open it from the thread again.
      </p>
    );
  const data = parsed.data;
  return (
    <PrDetail
      {...data}
      extensions={extensions}
      onState={onState}
      tab={prWorkspaceTab(props.tab.ui?.selected ?? "summary")}
      onTab={(tab) => actions.updateUi(props.tab.key, { selected: tab })}
      onOpen={(number) => actions.open(pullRequestTab({ ...data, number }))}
    />
  );
}
