import { useThreadMeta } from "@ace/client-react";
import { editedTurns, resolveScope, scopeEdits, scopeLabel, type DiffScope } from "@ace/ui-core";
import { useMemo } from "react";
import { z } from "zod";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useFileDiffs } from "./use-file-diffs.ts";
import { useTurns } from "./use-turns.ts";

export type Scope = DiffScope;
export { scopeLabel };
const tabData = z.looseObject({ scope: z.string().optional() });

/**
 * One persisted scope and one count for a Changes tab (`tabKey`), or for the first one open when
 * none is named (its badge and the work card).
 */
export function useScopedDiff(threadId: string, tabKey?: string) {
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const tab = workspace.tabs.find((candidate) =>
    tabKey === undefined ? candidate.kind === "changes" : candidate.key === tabKey,
  );
  const parsed = tabData.safeParse(tab?.data);
  const data = parsed.success ? parsed.data : {};
  const requested = data.scope ?? "last";
  const turns = useTurns(threadId);
  const edited = useMemo(() => editedTurns(turns), [turns]);
  const resolved = useMemo(() => resolveScope(requested, edited), [requested, edited]);
  const { scope } = resolved;
  const shown = useMemo(() => scopeEdits(resolved, edited), [resolved, edited]);
  const { files, pending, versions } = useFileDiffs(shown);
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
  return {
    scope,
    setScope,
    edited,
    files,
    pending,
    versions,
    stat,
    label: scopeLabel(scope, edited),
  };
}
