import { useMemo } from "react";
import type { ForgePrRow, VerifyRun } from "@ace/protocol";
import { workKey, type LinkedThreads } from "./linked-threads.ts";
import type { MergeRun } from "./merge-run.ts";
import { rowStep, waitingWord, type RowStep } from "./next-steps.ts";
import type { RowStepView } from "./pr-row.tsx";
import { stepLabel, useStepAction } from "./pr-step.tsx";

const keyOf = (row: ForgePrRow) => workKey(row.ref.repository, row.ref.number);

/**
 * Each listed PR's next step and what its row shows for it: the step's button (Merge toggles
 * the row in the merge selection while `merge` is on), or a quiet word while it waits.
 */
export function useRowSteps(input: {
  project: string;
  back: string;
  rows: readonly ForgePrRow[];
  viewer: string | undefined;
  linked: LinkedThreads;
  runs: readonly VerifyRun[];
  command: string | null | undefined;
}) {
  const { rows, viewer, linked, runs } = input;
  const steps = useMemo(() => {
    const found = new Map<string, RowStep>();
    for (const row of rows)
      found.set(keyOf(row), rowStep(row, viewer, linked.get(keyOf(row)), runs));
    return found;
  }, [rows, viewer, linked, runs]);
  const act = useStepAction(input.project, input.back);
  const stepOf = (row: ForgePrRow): RowStep =>
    steps.get(keyOf(row)) ?? { step: "wait", local: undefined };
  const view = (row: ForgePrRow, merge: MergeRun | undefined): RowStepView | undefined => {
    const { step, local } = stepOf(row);
    if (step === "wait") return { quiet: waitingWord(row, local) };
    const label = stepLabel(step);
    if (!label) return undefined;
    const thread = linked.get(keyOf(row));
    const press = () => act({ step, row, thread, local, command: input.command });
    // Merging picks the row for a verified merge; one without a known head merges on its page.
    if (step === "merge" && merge && row.headSha) {
      const picked = merge.isPicked(row);
      return {
        action: {
          label,
          pressed: picked,
          disabled: merge.blocked(row),
          onPress: () => merge.toggle(row),
        },
      };
    }
    return { action: { label, onPress: press } };
  };
  return { stepOf, view };
}
