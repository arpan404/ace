import { createContext, createElement, useContext, type ComponentType } from "react";
import type { TabViewProps } from "@/lib/workspace/index.ts";

const PullRequestViewContext = createContext<ComponentType<TabViewProps> | undefined>(undefined);

/**
 * The forge's pull request view, handed down by the app: the forge draws with the panels, so the
 * panels can't import it back.
 */
export const PullRequestViewProvider = PullRequestViewContext.Provider;

/** A `pull-request` tab: the view the app provides, or why it can't show here. */
export default function PullRequestView(props: TabViewProps) {
  const View = useContext(PullRequestViewContext);
  if (!View)
    return (
      <p role="alert" className="p-4 text-sm">
        Pull requests can't open here.
      </p>
    );
  return createElement(View, props);
}
