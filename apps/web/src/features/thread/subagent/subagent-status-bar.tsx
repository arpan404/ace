import type { ProviderKind } from "@ace/protocol";
import { subagentOutcome, type SubagentPhase } from "@ace/ui-core";
import { ArrowBendLeftUpIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { WorkingIndicator } from "@/components/working-indicator.tsx";
import { cn } from "@/lib/cn.ts";
import { composerSurface, stripControl } from "../composer/composer-styles.ts";

/** The parent a subagent leads back to: a thread, or the subagent that started it. */
export interface ParentLink {
  threadId: string;
  agentId?: string | undefined;
}

/**
 * What stands in the composer's place under a subagent while nobody is writing to it: who ran
 * it (provider, model, effort), how it went from the daemon's own times, how it runs, and its
 * actions (Stop, Continue, the way back to its parent), each passed in only when it applies.
 *
 * It fits its own column, not the window (`@container/subagent-bar`): as the column narrows,
 * how it runs goes first, then the effort, then the actions keep only their icons. The model's
 * name truncates last and never below a few characters.
 */
export function SubagentStatusBar(props: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  model: string;
  effort?: string | undefined;
  phase: SubagentPhase;
  startedAt: number;
  endedAt?: number | undefined;
  runs: string;
  parent?: ParentLink | undefined;
  actions?: ReactNode;
}) {
  return (
    <div className="@container/subagent-bar min-w-0">
      <div
        role="group"
        aria-label="Subagent"
        className={cn(
          composerSurface,
          "relative z-10 flex min-h-12 min-w-0 items-center gap-2 rounded-xl px-2 text-ui",
          // Narrow, Stop, Continue and Open parent keep their icons; their names stay spoken.
          "@max-[30rem]/subagent-bar:gap-1 @max-[30rem]/subagent-bar:[&_[data-slot=stop-label]]:sr-only @max-[30rem]/subagent-bar:[&_[data-slot=action-label]]:sr-only",
        )}
      >
        <span className="flex min-w-12 shrink items-center gap-1.5 pl-2">
          <ProviderIcon
            provider={props.provider}
            acpAgentId={props.acpAgentId}
            model={props.model}
            size={16}
            decorative
            className="shrink-0"
          />
          <span className="min-w-6 truncate font-medium">{props.model}</span>
          {props.effort && (
            <span className="shrink-0 text-muted-foreground @max-[26rem]/subagent-bar:hidden">
              {props.effort}
            </span>
          )}
        </span>
        {props.phase === "running" ? (
          // The live line's own look: its time ticks through a ref, never a render.
          <WorkingIndicator
            from={props.startedAt}
            className="shrink-0 pl-1 text-muted-foreground"
          />
        ) : (
          <span className="min-w-0 shrink truncate pl-1 text-muted-foreground tabular-nums">
            {subagentOutcome(props.phase, props.startedAt, props.endedAt, props.startedAt)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <span className="pr-1 text-xs text-subtle-foreground @max-[36rem]/subagent-bar:hidden">
            {props.runs}
          </span>
          {props.actions}
          {props.parent && <BackToParent parent={props.parent} />}
        </span>
      </div>
    </div>
  );
}

const backClass = cn(stripControl, "h-8 shrink-0 text-ui text-foreground");

function BackToParent(props: { parent: ParentLink }) {
  const { threadId, agentId } = props.parent;
  const inner = (
    <>
      <ArrowBendLeftUpIcon aria-hidden size={15} className="shrink-0" />
      {/* Narrow, the arrow alone; the model and how it went keep the room. */}
      <span data-slot="action-label">Open parent</span>
    </>
  );
  return agentId ? (
    <Link
      to="/t/$threadId/agents/$agentId"
      params={{ threadId, agentId }}
      aria-label="Open parent"
      className={backClass}
    >
      {inner}
    </Link>
  ) : (
    <Link to="/t/$threadId" params={{ threadId }} aria-label="Open parent" className={backClass}>
      {inner}
    </Link>
  );
}
