import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { WorktreeCreationCard } from "@/features/thread/index.ts";
import type { PrActions } from "./pr-actions.ts";
import { lifecycleLabels } from "@ace/ui-core";

function Row(props: { children: ReactNode; action: ReactNode }) {
  return (
    <p role="status" className="flex items-center justify-between gap-2 py-1 text-xs">
      <span className="min-w-0 truncate text-muted-foreground">{props.children}</span>
      {props.action}
    </p>
  );
}

const labelOf = (kind: string) =>
  kind in lifecycleLabels ? lifecycleLabels[kind as keyof typeof lifecycleLabels] : "PR edit";

/**
 * Writes GitHub hasn't confirmed yet, each with the one control that settles it, and a PR
 * checkout being prepared. Renders nothing when every write is settled.
 */
export function PrWriteStatus(props: { actions: PrActions; refreshing: boolean }) {
  const { lifecycle, writes, mergeState, worktree, context } = props.actions;
  const rows = [
    ...lifecycle.unresolved.map((op) => (
      <Row
        key={op.id}
        action={
          <Button
            size="xs"
            disabled={lifecycle.pending}
            onClick={() => void lifecycle.reconcile(op.id)}
          >
            Check action result
          </Button>
        }
      >
        {`${labelOf(op.kind)} · ${op.state === "uncertain" ? "Outcome unknown" : "Waiting for GitHub"}`}
      </Row>
    )),
    writes.fenced && (
      <Row
        key="link-writes"
        action={
          <Button
            size="xs"
            disabled={writes.pending || props.refreshing}
            onClick={() => void writes.reconcile()}
          >
            Reconcile action
          </Button>
        }
      >
        Last change not confirmed
      </Row>
    ),
    mergeState.uncertain && (
      <Row
        key="merge-state"
        action={
          <Button
            size="xs"
            disabled={mergeState.pending || mergeState.query.isFetching}
            onClick={() => void mergeState.confirm()}
          >
            Check auto-merge result
          </Button>
        }
      >
        Auto-merge change not confirmed
      </Row>
    ),
  ].filter(Boolean);
  if (!rows.length && !worktree.state) return null;
  return (
    <div
      role="group"
      aria-label="Unconfirmed changes"
      className="shrink-0 px-[var(--forge-gutter,1rem)] pb-1"
    >
      {rows}
      {worktree.state && (
        <WorktreeCreationCard
          state={worktree.state}
          onAction={worktree.act}
          workspaceId={context.workspaceId}
        />
      )}
    </div>
  );
}
