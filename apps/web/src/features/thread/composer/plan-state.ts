import type { ThreadReader } from "@ace/client";
import { arrayEqual, useThread } from "@ace/client-react";
import {
  latestPlanSteps,
  planProgress,
  planShown,
  planTodos,
  samePlanSteps,
  type PlanProgress,
  type PlanStep,
} from "@ace/ui-core";
import { useCallback, useMemo } from "react";

/** An agent's to-do list the composer's tab shows, and how far along it is. */
export interface ShownPlan {
  step: PlanStep;
  progress: PlanProgress;
}

const none: readonly ShownPlan[] = [];
const planKeys = ["order", "thread"] as const;
const samePlans = (a: readonly ShownPlan[], b: readonly ShownPlan[]) =>
  arrayEqual(
    a.map((plan) => plan.progress.todos),
    b.map((plan) => plan.progress.todos),
  ) &&
  samePlanSteps(
    a.map((plan) => plan.step),
    b.map((plan) => plan.step),
  );

/**
 * The thread's to-do lists in view, the main agent's first: each agent's latest list in its
 * latest turn, live as the agent updates it, until every item is settled and that turn ended.
 */
export function useShownPlans(threadId: string): readonly ShownPlan[] {
  const steps = useThread(threadId, planKeys, latestPlanSteps, samePlanSteps);
  const keys = useMemo(
    () =>
      (steps ?? []).flatMap((step) =>
        step.runId
          ? [`item:${step.itemId}` as const, `run:${step.runId}` as const]
          : [`item:${step.itemId}` as const],
      ),
    [steps],
  );
  const read = useCallback(
    (reader: ThreadReader): readonly ShownPlan[] =>
      (steps ?? []).flatMap((step) => {
        const item = reader.item(step.itemId);
        const run = step.runId ? reader.run(step.runId) : undefined;
        const progress = planProgress(
          planTodos(item?.type === "tool_call" ? item.call.detail : undefined),
        );
        return planShown(progress, run ? run.state !== "active" : true) ? [{ step, progress }] : [];
      }),
    [steps],
  );
  return useThread(threadId, keys, read, samePlans) ?? none;
}
