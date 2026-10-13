import { useState } from "react";
import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  UserCircleCheckIcon,
  UserCircleDashedIcon,
  UserCircleMinusIcon,
  WarningCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgeStackLayer } from "@ace/protocol";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import {
  checkStateLabel,
  layerChecksSignal,
  layerMergeBlocker,
  layerStateLabel,
  reviewSignal,
  type Signal,
} from "./pr-stack-labels.ts";

const tone: Record<Signal, string> = {
  good: "text-status-done",
  pending: "text-status-waiting",
  bad: "text-status-failed",
  unknown: "text-subtle-foreground",
};
const checkGlyph: Record<Signal, IconGlyph> = {
  good: CheckCircleIcon,
  pending: ClockIcon,
  bad: XCircleIcon,
  unknown: CircleIcon,
};
const reviewGlyph: Record<Signal, IconGlyph> = {
  good: UserCircleCheckIcon,
  pending: UserCircleDashedIcon,
  bad: UserCircleMinusIcon,
  unknown: UserCircleDashedIcon,
};

/** One glyph with its meaning as accessible name and hover tip. */
function Glyph(props: { icon: IconGlyph; label: string; className: string }) {
  return (
    <Tip label={props.label}>
      <span className={cn("inline-grid size-5 place-items-center", props.className)}>
        <Icon icon={props.icon} size={14} label={props.label} />
      </span>
    </Tip>
  );
}

function stateGlyph(layer: ForgeStackLayer): { icon: IconGlyph; label: string; className: string } {
  const state = layerStateLabel(layer.state);
  if (layer.state === "MERGED")
    return { icon: GitMergeIcon, label: state, className: "text-status-done" };
  if (layer.state !== "OPEN")
    return { icon: XCircleIcon, label: state, className: "text-subtle-foreground" };
  const { blocked, label: rules } = layerMergeBlocker(layer);
  return blocked
    ? { icon: WarningCircleIcon, label: `${state} · ${rules}`, className: "text-status-needs-you" }
    : {
        icon: GitPullRequestIcon,
        label: `${state} · ${rules}`,
        className: "text-muted-foreground",
      };
}

/** Branches, head, merge rules, queue and the required checks GitHub reported for one layer. */
function LayerDetails(props: { layer: ForgeStackLayer }) {
  const { layer } = props;
  const review = reviewSignal(layer.reviewDecision);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1 pb-2 pl-12 text-xs text-muted-foreground">
      <dt>Branch</dt>
      <dd className="min-w-0 truncate font-mono">
        {layer.baseBranch} ← {layer.branch} · {layer.headSha.slice(0, 7)}
      </dd>
      <dt>Merge</dt>
      <dd>
        {layerMergeBlocker(layer).label}
        {layer.queueState ? ` · Queue: ${layer.queueState.toLowerCase()}` : ""}
      </dd>
      <dt>Review</dt>
      <dd>{review.label}</dd>
      <dt>Required</dt>
      <dd>
        {layer.requiredChecks.length ? (
          <ul aria-label={`Required checks for #${layer.number}`}>
            {layer.requiredChecks.map((check) => (
              <li key={check.name}>
                {check.name}: {checkStateLabel(check.state)}
              </li>
            ))}
            {layer.checksTruncated && <li>More checks on GitHub</li>}
          </ul>
        ) : layer.checksTruncated ? (
          "More checks on GitHub"
        ) : (
          "None reported"
        )}
      </dd>
    </dl>
  );
}

/** One row per layer, bottom of the stack first; the open PR is highlighted. */
export function StackRail(props: {
  layers: readonly ForgeStackLayer[];
  current: number;
  onOpen(number: number): void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const toggle = (number: number) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(number)) next.add(number);
      return next;
    });
  return (
    <ol aria-label="Stack layers" className="space-y-px">
      {props.layers.map((layer) => {
        const selected = layer.number === props.current;
        const open = expanded.has(layer.number);
        const checks = layerChecksSignal(layer);
        const review = reviewSignal(layer.reviewDecision);
        const state = stateGlyph(layer);
        return (
          <li key={layer.number}>
            <div
              className={cn(
                "flex h-8 items-center gap-1 rounded-md pr-1 text-ui hover:bg-accent",
                selected && "bg-accent",
              )}
            >
              <button
                type="button"
                aria-current={selected ? "page" : undefined}
                aria-label={`Layer ${layer.position}: #${layer.number} ${layer.title}`}
                onClick={() => props.onOpen(layer.number)}
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left focus-ring"
              >
                <span className="w-4 shrink-0 text-xs text-subtle-foreground tabular-nums">
                  {layer.position}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">#{layer.number}</span>
                <span className={cn("min-w-0 truncate", selected && "font-medium")}>
                  {layer.title}
                </span>
              </button>
              <Glyph {...state} />
              <Glyph
                icon={checkGlyph[checks.signal]}
                label={checks.label}
                className={tone[checks.signal]}
              />
              <Glyph
                icon={reviewGlyph[review.signal]}
                label={review.label}
                className={tone[review.signal]}
              />
              <IconButton
                icon={CaretRightIcon}
                size="sm"
                label={`Details for #${layer.number}`}
                tip="Details"
                aria-expanded={open}
                className={cn("transition-transform", open && "rotate-90")}
                onClick={() => toggle(layer.number)}
              />
            </div>
            {open && <LayerDetails layer={layer} />}
          </li>
        );
      })}
    </ol>
  );
}
