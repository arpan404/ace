import { formatAgo } from "@ace/ui-core";
import { hairlineGrid } from "@/components/ui/rules.ts";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useNow } from "@/lib/time.ts";
import { cn } from "@/lib/cn.ts";
import type { PrActions } from "./pr-actions.ts";
import { usePrActivityEvents } from "./pr-activity-events.ts";
import { prGates, type Gate, type GateKey } from "./pr-gates.ts";
import { reviewerOutcomes } from "./pr-summary-model.ts";

/** How a finished PR ended, from its activity: who and when, and what became of the branch. */
function useEnding(actions: PrActions) {
  const { detail, workspaceId } = actions.context;
  const finished = detail.status.state === "merged" || detail.status.state === "closed";
  // Only a finished PR's gates read its activity; an open one never waits on it.
  const activity = usePrActivityEvents({ workspaceId, detail, enabled: finished });
  const now = useNow();
  if (!finished || !activity.data) return { ended: undefined, branchDeleted: undefined };
  const events = activity.data.events;
  const end = events.findLast((event) => event.event === detail.status.state);
  const at = end?.at ? Date.parse(end.at) : NaN;
  return {
    ended: end
      ? { by: end.actor, ago: Number.isFinite(at) ? formatAgo(at, now) : undefined }
      : undefined,
    branchDeleted: events.some((event) => event.event === "head_ref_deleted"),
  };
}

function Cell(props: { gate: Gate; loading: boolean; onSelect(key: GateKey): void }) {
  const { gate } = props;
  return (
    <button
      type="button"
      onClick={() => props.onSelect(gate.key)}
      aria-label={`${gate.label}: ${gate.value}${gate.detail ? `, ${gate.detail}` : ""}`}
      className="flex min-w-0 flex-col gap-0.5 bg-panel py-2 pr-2 pl-4 text-left transition-colors duration-(--motion-fast) focus-ring-inset hover:bg-hover"
    >
      <span className="text-meta text-subtle-foreground">{gate.label}</span>
      {props.loading ? (
        <Skeleton className="my-1 h-3 w-16 rounded-full" />
      ) : (
        <span
          key={gate.value}
          className="fx-cross-in flex min-w-0 items-center gap-1.5 text-xs tabular-nums"
        >
          <span
            aria-hidden
            data-tone={gate.tone === "idle" ? undefined : gate.tone}
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              gate.tone === "idle" ? "bg-faint-foreground" : "bg-(--tone)",
            )}
          />
          <span
            className={cn(
              "min-w-0 break-words",
              gate.tone === "idle" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {gate.value}
          </span>
        </span>
      )}
      {gate.detail && !props.loading && (
        <span className="pl-3 text-2xs text-subtle-foreground tabular-nums">{gate.detail}</span>
      )}
    </button>
  );
}

/**
 * The merge gates: four cells between hairlines saying what stands between this PR and a
 * merge, or how it ended. Two by two on a narrow panel. Each cell jumps to its detail.
 */
export function PrGatesRow(props: { actions: PrActions; onSelect(key: GateKey): void }) {
  const { actions } = props;
  const { detail } = actions.context;
  const { ended, branchDeleted } = useEnding(actions);
  const gates = prGates({
    status: detail.status,
    reviewDecision: detail.reviewDecision,
    mergeState: actions.mergeState.state,
    baseBranch: detail.baseBranch,
    outcomes: reviewerOutcomes(detail.status.comments),
    ended,
    branchDeleted,
  });
  const open = detail.status.state === "open" || detail.status.state === "draft";
  const branchLoading = open && actions.mergeState.query.isPending;
  return (
    <nav
      aria-label="Merge gates"
      className={cn(
        hairlineGrid,
        "shrink-0 grid-cols-4 border-t border-border @max-[30rem]/pr:grid-cols-2",
      )}
    >
      {gates.map((gate) => (
        <Cell
          key={gate.key}
          gate={gate}
          loading={gate.key === "branch" && branchLoading}
          onSelect={props.onSelect}
        />
      ))}
    </nav>
  );
}
