import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  verifyMergeLimit,
  type ForgePrRow,
  type VerifyRun,
  type VerifyTarget,
} from "@ace/protocol";
import { type MergeMethod, workKey } from "@ace/ui-core";
import { useToast } from "@/components/ui/toast.tsx";
import { isSettled, useVerifyActions, VerifyRefused } from "@/lib/verify.ts";

const keyOf = (row: ForgePrRow) => workKey(row.ref.repository, row.ref.number);

const refusals: Partial<Record<VerifyRefused["code"], string>> = {
  no_command: "This project has no check command.",
  busy: "Too many runs are waiting in this project. Try again once one ends.",
  forbidden: "This device can't start runs on this machine.",
  settled: "Merging on GitHub has begun, so it can't be stopped.",
};
const refusal = (error: unknown) =>
  (error instanceof VerifyRefused ? refusals[error.code] : undefined) ??
  "Verify didn't answer. Try again.";

/**
 * The list's verified merge: the ready pull requests picked for it, in list order, and the
 * merge run they started. The strip shows a live run, or the ending of the one started here
 * until it is dismissed or a new selection begins; any run that merged refreshes the list.
 */
export function useMergeRun(
  project: string,
  ready: readonly ForgePrRow[],
  runs: readonly VerifyRun[],
) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [own, setOwn] = useState<string>();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const verify = useVerifyActions(project);
  const toast = useToast();
  const cache = useQueryClient();
  const selected = ready.filter((row) => row.headSha && picked.has(keyOf(row)));
  const base = selected[0]?.baseBranch;
  const run = runs.find(
    (each) =>
      each.target.kind === "merge" &&
      !dismissed.has(each.id) &&
      (!isSettled(each) || each.id === own),
  );
  const shown = run && (!isSettled(run) || selected.length === 0) ? run : undefined;
  // What merged left the open list: read it again.
  const merged = run && isSettled(run) && run.merged.length > 0 ? run.id : undefined;
  useEffect(() => {
    if (merged) void cache.invalidateQueries({ queryKey: ["forge", project] });
  }, [cache, merged, project]);

  const start = async (target: VerifyTarget) => {
    try {
      const started = await verify.start(target);
      if (started) setOwn(started.id);
      setPicked(new Set());
    } catch (error) {
      toast.error({ title: "Couldn't start the merge", description: refusal(error) });
    }
  };
  const forget = (id: string) => {
    setDismissed((current) => new Set(current).add(id));
    if (own === id) setOwn(undefined);
  };
  return {
    selected,
    base,
    run: shown,
    pending: verify.pending,
    isPicked: (row: ForgePrRow) => picked.has(keyOf(row)),
    /** Why `row` can't join the selection now; undefined when it can. */
    blocked(row: ForgePrRow): string | undefined {
      if (picked.has(keyOf(row))) return undefined;
      if (selected.length >= verifyMergeLimit)
        return `At most ${verifyMergeLimit} pull requests merge at once`;
      if (base !== undefined && row.baseBranch !== base) return `Pick pull requests into ${base}`;
      return undefined;
    },
    toggle(row: ForgePrRow) {
      const key = keyOf(row);
      setPicked((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      });
      if (run && isSettled(run)) forget(run.id);
    },
    clear: () => setPicked(new Set()),
    start: (method: MergeMethod) =>
      start({
        kind: "merge",
        method,
        prs: selected.flatMap((row) =>
          row.headSha
            ? [{ pr: row.ref, headSha: row.headSha, title: row.title.slice(0, 512) }]
            : [],
        ),
      }),
    again: (from: VerifyRun) => {
      forget(from.id);
      return start(from.target);
    },
    without: (from: VerifyRun, pr: number) => {
      if (from.target.kind !== "merge") return;
      forget(from.id);
      return start({
        ...from.target,
        prs: from.target.prs.filter((each) => each.pr.number !== pr),
      });
    },
    cancel: async (from: VerifyRun) => {
      try {
        await verify.cancel(from.id);
      } catch (error) {
        toast.error({ title: "Couldn't stop the merge", description: refusal(error) });
      }
    },
    dismiss: (from: VerifyRun) => forget(from.id),
  };
}
export type MergeRun = ReturnType<typeof useMergeRun>;
