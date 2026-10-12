import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { usePrWorkspaceExtensions } from "./pr-extension-context.tsx";
import { PrDetail, prWorkspaceTab } from "./pr-detail.tsx";
import { PrPanelData, prPanelId, prPanelRepository } from "./pr-panel-data.ts";

export default function PrPanelTab(props: TabViewProps) {
  const actions = useWorkspaceActions(props.scope);
  const extensions = usePrWorkspaceExtensions();
  const navigate = useNavigate();
  const parsed = PrPanelData.safeParse(props.tab.data);
  const onState = useCallback(
    (state: import("@ace/protocol").ForgePrStatus["state"]) => {
      const identity = PrPanelData.safeParse(props.tab.data);
      if (identity.success && identity.data.state !== state)
        actions.update(props.tab.key, { data: { ...identity.data, state } });
    },
    [actions, props.tab.key, props.tab.data],
  );
  if (!parsed.success)
    return (
      <p role="alert" className="p-4 text-sm">
        This pull request tab has an invalid identity. Open it from the list again.
      </p>
    );
  const data = parsed.data;
  const open = (number: number) => {
    const repo = prPanelRepository(data);
    actions.open({
      kind: "pull-request",
      id: prPanelId({ ...data, number }),
      title: `#${number}`,
      data: { workspaceId: data.workspaceId, repository: data.repository, number },
    });
    void navigate({
      to: "/pull-requests",
      search: (previous) => ({
        ...previous,
        project: data.workspaceId,
        repo,
        number,
        tab: "summary",
      }),
    });
  };
  return (
    <PrDetail
      {...data}
      extensions={extensions}
      onState={onState}
      tab={prWorkspaceTab(props.tab.ui?.selected ?? "summary")}
      onTab={(tab) => {
        actions.updateUi(props.tab.key, { selected: tab });
        void navigate({
          to: "/pull-requests",
          search: (previous) => ({
            ...previous,
            project: data.workspaceId,
            repo: prPanelRepository(data),
            number: data.number,
            tab: prWorkspaceTab(tab),
          }),
        });
      }}
      onBack={() => {
        actions.setOpen(false);
        void navigate({
          to: "/pull-requests",
          search: (previous) => ({
            ...previous,
            project: data.workspaceId,
            repo: prPanelRepository(data),
            number: undefined,
          }),
        });
      }}
      onOpen={open}
    />
  );
}
