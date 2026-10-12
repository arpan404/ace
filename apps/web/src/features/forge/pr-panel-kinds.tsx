import { GitPullRequestIcon, PlusIcon } from "@phosphor-icons/react";
import { defineTabKind } from "@/lib/workspace/index.ts";
import { PrPanelData } from "./pr-panel-data.ts";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";

export default [
  defineTabKind({
    kind: "pull-request",
    label: "Pull request",
    icon: GitPullRequestIcon,
    TabIcon: (props) => (
      <span className={props.className}>
        <PullRequestGlyph
          state={(() => {
            const data = PrPanelData.safeParse(props.tab.data);
            return data.success && data.data.state !== "unknown" ? data.data.state : undefined;
          })()}
          size={14}
        />
      </span>
    ),
    title: (tab) => tab.title ?? "Pull request",
    load: () => import("./pr-panel-tab.tsx"),
  }),
  defineTabKind({
    kind: "pr-new",
    label: "New pull request tab",
    icon: PlusIcon,
    load: () => import("./pr-panel-launcher.tsx"),
  }),
];
