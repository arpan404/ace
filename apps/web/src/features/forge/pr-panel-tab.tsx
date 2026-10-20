import { useCallback } from "react";
import type { ForgePrRef, ForgePrStatus, ForgeRepository } from "@ace/protocol";
import { PullRequestOpener } from "@/components/pull-request-link.tsx";
import {
  pullRequestTab,
  PullRequestTabData,
  useWorkspaceActions,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { usePrWorkspaceExtensions } from "./pr-extension-context.tsx";
import { PrDetail, prWorkspaceTab } from "./pr-detail.tsx";

const sameRepository = (a: ForgeRepository | undefined, b: ForgeRepository) =>
  !!a &&
  `${a.host}/${a.owner}/${a.name}`.toLowerCase() === `${b.host}/${b.owner}/${b.name}`.toLowerCase();

/**
 * One pull request in a side panel tab; another PR it links to, in its own repository or
 * another, opens in a tab beside it.
 */
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
  // A PR of this tab's repository keeps its identity, so it reuses a tab already open for it.
  const openLinked = (pr: ForgePrRef) =>
    actions.open(
      pullRequestTab(
        sameRepository(data.repository, pr.repository)
          ? { ...data, number: pr.number }
          : { workspaceId: data.workspaceId, repository: pr.repository, number: pr.number },
      ),
    );
  return (
    <PullRequestOpener value={openLinked}>
      <PrDetail
        {...data}
        extensions={extensions}
        hostThreadId={props.scope}
        onState={onState}
        tab={prWorkspaceTab(props.tab.ui?.selected ?? "summary")}
        onTab={(tab) => actions.updateUi(props.tab.key, { selected: tab })}
        onOpen={(number) => actions.open(pullRequestTab({ ...data, number }))}
      />
    </PullRequestOpener>
  );
}
