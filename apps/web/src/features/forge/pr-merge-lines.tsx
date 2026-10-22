import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openExternal } from "@/boot/open-external.ts";
import { useToast } from "@/components/ui/toast.tsx";
import type { PrActions } from "./pr-actions.ts";
import { humanize } from "./pr-stack-labels.ts";

function eta(seconds: number): string {
  return seconds < 60 ? "under a minute" : `~${Math.round(seconds / 60)}m`;
}

/**
 * What the gates row can't say: the branch rules GitHub holds the merge on, a queued PR's
 * state, and where the head is deployed. Nothing for a finished PR or before GitHub answers;
 * the gates row shows that wait.
 */
export function PrMergeLines(props: { actions: PrActions }) {
  const toast = useToast();
  const { status } = props.actions.context.detail;
  const state = props.actions.mergeState.state;
  if (!state || (status.state !== "open" && status.state !== "draft")) return null;
  const rules = state.rules ?? [];
  const deployments = state.deployments ?? [];
  const estimate = state.queue?.estimatedTimeToMerge;
  if (!rules.length && !state.queue && !deployments.length) return null;
  return (
    <div className="space-y-0.5 px-[var(--forge-gutter,1rem)] pb-2 text-xs text-muted-foreground tabular-nums">
      {state.queue && (
        <p>
          Merge queue · {humanize(state.queue.state)}
          {typeof estimate === "number" && ` · ${eta(estimate)}`}
        </p>
      )}
      {rules.map((rule) => (
        <p key={rule}>{rule}</p>
      ))}
      {deployments.map((deployment) => {
        const label = `${deployment.environment} · ${humanize(deployment.state)}`;
        const url = deployment.url;
        return url ? (
          <button
            key={deployment.environment}
            type="button"
            onClick={() =>
              void openExternal(url).catch(() =>
                toast.error({ title: "Couldn't open the deployment" }),
              )
            }
            className="flex max-w-full items-center gap-1 rounded-xs focus-ring touch-hit hover:underline"
          >
            <span className="truncate">{label}</span>
            <ArrowSquareOutIcon aria-hidden size={12} className="shrink-0" />
          </button>
        ) : (
          <p key={deployment.environment} className="truncate">
            {label}
          </p>
        );
      })}
    </div>
  );
}
