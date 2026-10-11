import { type ThreadDetails } from "@ace/protocol";
import { countChanges, parseUnifiedDiff } from "@ace/ui-core";
import { useMemo } from "react";
import { DiffStat } from "./diff-stat.tsx";
import type { Turn } from "@ace/ui-core";
import { readGitDiff } from "@/lib/git-diff.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { GitDiffIcon } from "@phosphor-icons/react";
import { ScopeMenu, type Scope } from "./changes-toolbar.tsx";

/** Read git rather than provider edit events: shell commands and manual edits count too. */
export function WorkingTreeDiff(props: {
  threadId: string;
  details: ThreadDetails | undefined;
  state: string | undefined;
  turns: readonly Turn[];
  onScope(scope: Scope): void;
}) {
  const diff = useDaemonQuery({
    queryKey: ["working-tree-diff", props.threadId, props.state, props.details?.head],
    staleTime: 0,
    retry: false,
    read: (client, signal) => readGitDiff(client, props.threadId, signal),
  });
  const stat = useMemo(
    () => countChanges(parseUnifiedDiff(diff.data?.patch ?? "")),
    [diff.data?.patch],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="toolbar"
        aria-label="Changes"
        className="flex items-center justify-between border-b px-2 py-1.5"
      >
        <ScopeMenu scope="working-tree" turns={props.turns} onScope={props.onScope} />
        {(stat.additions > 0 || stat.deletions > 0) && <DiffStat {...stat} />}
        <Button
          size="sm"
          variant="ghost"
          disabled={diff.isFetching}
          onClick={() => void diff.refetch()}
        >
          Refresh
        </Button>
      </div>
      {diff.isError ? (
        <EmptyState
          icon={GitDiffIcon}
          title="Couldn't read changes"
          description="Check that this thread has a git checkout, then refresh."
        />
      ) : diff.data ? (
        diff.data.patch ? (
          <div className="min-h-0 flex-1 overflow-auto p-3.5">
            {diff.data.truncated && (
              <p role="status" className="mb-2 text-xs text-muted-foreground">
                This diff is truncated at 256 KiB.
              </p>
            )}
            <pre
              aria-label="Uncommitted diff"
              className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed"
            >
              {diff.data.patch}
            </pre>
          </div>
        ) : (
          <EmptyState
            icon={GitDiffIcon}
            title="No uncommitted changes"
            description="The working tree matches HEAD."
            className="justify-start pt-6"
          />
        )
      ) : (
        <p role="status" className="p-3.5 text-sm text-muted-foreground">
          Reading changes…
        </p>
      )}
    </div>
  );
}
