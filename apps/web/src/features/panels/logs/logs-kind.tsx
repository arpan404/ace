import { ScrollIcon } from "@phosphor-icons/react";
import { defineTabKind } from "@/lib/workspace/index.ts";
import { OutputSkeleton } from "../tab-skeletons.tsx";
import { logScopeTitle } from "./scopes.ts";

/*
 * Logs as a scoped resource: one tab per source (`logs` the thread, `logs:agent:<id>` one
 * agent and the subagents under it, `logs:daemon` the daemon's health). The scope picker in the
 * tab swaps one for another in place.
 */
export const logsKind = defineTabKind({
  kind: "logs",
  label: "Logs",
  icon: ScrollIcon,
  launcher: 80,
  title: (tab) => logScopeTitle(tab.id, tab.title),
  Skeleton: OutputSkeleton,
  load: () => import("./logs-tab.tsx"),
});
