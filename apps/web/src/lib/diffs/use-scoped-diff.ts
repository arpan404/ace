import { useThreadMeta } from "@ace/client-react";
import type { Turn } from "@ace/ui-core";
import { useMemo } from "react";
import { z } from "zod";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useFileDiffs } from "./use-file-diffs.ts";
import { useTurns } from "./use-turns.ts";

export type Scope = "last" | "all" | (string & {});
const tabData = z.looseObject({ scope: z.string().optional() });

export function scopeLabel(scope: Scope, turns: readonly Turn[]): string {
  if (scope === "working-tree") return "Uncommitted";
  if (scope === "all") return "All turns";
  if (scope === "last") return "Last turn";
  const turn = turns.find((candidate) => candidate.id === scope);
  return turn ? `Turn ${turn.number}` : "Last turn";
}

/** One persisted scope and one count for the Changes view, its badge and the work card. */
export function useScopedDiff(threadId: string) {
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const tab = workspace.tabs.find((candidate) => candidate.kind === "changes");
  const parsed = tabData.safeParse(tab?.data);
  const data = parsed.success ? parsed.data : {};
  const requested = data.scope ?? "last";
  const turns = useTurns(threadId);
  const edited = useMemo(() => turns.filter((turn) => turn.edits.length), [turns]);
  const scope =
    !edited.length || requested === "working-tree"
      ? "working-tree"
      : requested === "all" || edited.some((turn) => turn.id === requested)
        ? requested
        : "last";
  const turn =
    scope === "all" || scope === "working-tree"
      ? undefined
      : (edited.find((candidate) => candidate.id === scope) ?? edited.at(-1));
  const shown = useMemo(
    () =>
      scope === "working-tree" ? [] : turn ? turn.edits : edited.flatMap((each) => each.edits),
    [scope, turn, edited],
  );
  const { files, pending } = useFileDiffs(shown);
  const details = useThreadMeta(threadId)?.details;
  const stat = useMemo(
    () =>
      scope === "working-tree"
        ? { additions: details?.diff?.additions ?? 0, deletions: details?.diff?.deletions ?? 0 }
        : files.reduce(
            (sum, file) => ({
              additions: sum.additions + file.additions,
              deletions: sum.deletions + file.deletions,
            }),
            { additions: 0, deletions: 0 },
          ),
    [scope, details?.diff, files],
  );
  const setScope = (next: Scope) => {
    if (tab) actions.update(tab.key, { data: { ...data, scope: next } });
  };
  return { scope, setScope, edited, files, pending, stat, label: scopeLabel(scope, edited) };
}
