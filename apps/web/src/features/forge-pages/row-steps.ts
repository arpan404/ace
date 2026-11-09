import {
  prNextAction,
  prStatusWords,
  prWorkGroup,
  rowStep,
  workKey,
  type LinkedThread,
  type LinkedThreads,
  type PrStatusWords,
  type PrWorkGroup,
  type RowStep,
} from "@ace/ui-core";
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ForgePrRow, VerifyRun } from "@ace/protocol";
import type { MergeRun } from "./merge-run.ts";
import { useMarkReady } from "./mark-ready.ts";
import { useStepAction } from "./pr-step.tsx";
import { repositoryParam } from "@/lib/pull-request-route.ts";

const keyOf = (row: ForgePrRow) => workKey(row.ref.repository, row.ref.number);

/** What a row's right column shows: its state in words, and the action that moves it on. */
export interface RowStepView {
  status: PrStatusWords;
  action: {
    label: string;
    pressed?: boolean | undefined;
    /** Why it can't be pressed now. */
    disabled?: string | undefined;
    onPress(): void;
  };
}

/**
 * Each listed PR's next step, its group (Needs you, Agents working, Waiting on others, Ready to
 * merge) and what its row shows: the state in words and the next action. Merge toggles the row
 * in the merge selection while `merge` is on; elsewhere actions open the PR, its code, or the
 * agent's thread.
 */
export function useRowSteps(input: {
  back: string;
  rows: readonly ForgePrRow[];
  projectOf(row: ForgePrRow): string;
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
  const act = useStepAction(input.back);
  const markReady = useMarkReady();
  const navigate = useNavigate();
  const threadOf = (row: ForgePrRow): LinkedThread | undefined => linked.get(keyOf(row));
  const stepOf = (row: ForgePrRow): RowStep =>
    steps.get(keyOf(row)) ?? { step: "wait", local: undefined };
  const groupOf = (row: ForgePrRow): PrWorkGroup => prWorkGroup(stepOf(row).step, threadOf(row));
  const openPr = (row: ForgePrRow) =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project: input.projectOf(row), number: String(row.ref.number) },
      search: { back: input.back, repo: repositoryParam(row.ref.repository) },
    });
  const view = (row: ForgePrRow, merge: MergeRun | undefined): RowStepView => {
    const { step, local } = stepOf(row);
    const thread = threadOf(row);
    const status = prStatusWords(row, step, local, thread);
    const label = prNextAction(row, step, thread, viewer);
    const group = groupOf(row);
    // Merging picks the row for a verified merge; one without a known head merges on its page.
    if (group === "merge" && merge && row.headSha)
      return {
        status,
        action: {
          label,
          pressed: merge.isPicked(row),
          disabled: merge.blocked(row),
          onPress: () => merge.toggle(row),
        },
      };
    if (group === "agents" && thread)
      return {
        status,
        action: {
          label,
          onPress: () => void navigate({ to: "/t/$threadId", params: { threadId: thread.id } }),
        },
      };
    if (row.ref.repository.forge !== "github" && step !== "answer")
      return {
        status:
          row.state === "closed" || row.state === "merged"
            ? status
            : { words: "Review status unavailable", tone: undefined },
        action: { label: "View", onPress: () => openPr(row) },
      };
    if (label === "Mark ready")
      return {
        status,
        action: { label, onPress: () => void markReady(input.projectOf(row), row) },
      };
    if (group === "wait" || group === "merge")
      return { status, action: { label, onPress: () => openPr(row) } };
    return {
      status,
      action: {
        label,
        onPress: () =>
          act({ project: input.projectOf(row), step, row, thread, local, command: input.command }),
      },
    };
  };
  return { stepOf, groupOf, threadOf, view };
}
