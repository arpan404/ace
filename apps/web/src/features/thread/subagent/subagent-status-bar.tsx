import { useAgent, useThreadMeta } from "@ace/client-react";
import type { ProviderKind } from "@ace/protocol";
import { agentName, subagentOutcome, type SubagentPhase } from "@ace/ui-core";
import { ArrowBendLeftUpIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import type { GlyphState } from "@ace/ui-core";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { controlDivider } from "@/components/ui/rules.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { WorkingIndicator } from "@/components/working-indicator.tsx";
import { cn } from "@/lib/cn.ts";
import { composerSurface, stripControl } from "../composer/composer-styles.ts";
import { useMachineSearch } from "@/lib/machine-routes.ts";

/** The parent a subagent leads back to: a thread, or the subagent that started it. */
export interface ParentLink {
  threadId: string;
  agentId?: string | undefined;
}

/** A labelled action in the bar (Continue, Stop, Ask parent to retry). */
export const barAction = cn(stripControl, "h-7.5 shrink-0 rounded-md text-ui text-foreground");

/** How a phase that has settled, or that waits on someone, is marked beside its words. */
const outcomeGlyphs: Partial<Record<SubagentPhase, GlyphState>> = {
  done: "done",
  failed: "failed",
  stopped: "stopped",
  human: "needs-you",
};

/**
 * What stands in the composer's place under a subagent while nobody is writing to it: who ran
 * it (provider, model, effort), how it went from the daemon's own times, and its actions (Stop,
 * Continue, Fork, the way back to its parent), each passed in only when it applies.
 *
 * It fits its own column, not the window (`@container/subagent-bar`): as the column narrows,
 * labelled actions keep only their icons, then the model and effort leave the provider mark
 * alone, so how it went keeps its words.
 */
export function SubagentStatusBar(props: {
  provider: ProviderKind;
  acpAgentId?: string | undefined;
  model: string;
  effort?: string | undefined;
  phase: SubagentPhase;
  startedAt: number;
  endedAt?: number | undefined;
  parent?: ParentLink | undefined;
  actions?: ReactNode;
}) {
  const glyph = outcomeGlyphs[props.phase];
  return (
    <div className="@container/subagent-bar min-w-0">
      <div
        role="group"
        aria-label="Subagent"
        className={cn(
          composerSurface,
          "relative z-10 flex h-12 min-w-0 items-center gap-2 rounded-xl pr-2 pl-4 text-ui",
          // Narrow, labelled actions keep their icons; their names stay spoken.
          "@max-[30rem]/subagent-bar:pl-3 @max-[30rem]/subagent-bar:[&_[data-slot=stop-label]]:sr-only @max-[30rem]/subagent-bar:[&_[data-slot=action-label]]:sr-only",
        )}
      >
        <span className="flex min-w-4 shrink items-center gap-2">
          <ProviderIcon
            provider={props.provider}
            acpAgentId={props.acpAgentId}
            model={props.model}
            size={16}
            decorative
            className="shrink-0"
          />
          <span className="min-w-6 truncate font-medium @max-[26rem]/subagent-bar:sr-only">
            {props.model}
          </span>
          {props.effort && (
            <span className="shrink-0 text-subtle-foreground @max-[26rem]/subagent-bar:hidden">
              {props.effort}
            </span>
          )}
        </span>
        <span aria-hidden className={controlDivider} />
        {props.phase === "running" ? (
          // The live line's own look: its time ticks through a ref, never a render.
          <WorkingIndicator from={props.startedAt} className="shrink-0 text-muted-foreground" />
        ) : (
          <span className="flex min-w-0 shrink items-center gap-1.5 text-muted-foreground tabular-nums">
            {glyph && <StatusGlyph state={glyph} size={12} />}
            <span className="truncate">
              {subagentOutcome(props.phase, props.startedAt, props.endedAt, props.startedAt)}
            </span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {props.actions}
          {props.parent && <BackToParent parent={props.parent} />}
        </span>
      </div>
    </div>
  );
}

const backClass =
  "inline-grid size-7.5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:bg-accent hover:text-foreground";

function BackToParent(props: { parent: ParentLink }) {
  const { threadId, agentId } = props.parent;
  const icon = <ArrowBendLeftUpIcon aria-hidden size={16} />;
  const title = useThreadMeta(threadId)?.title;
  const agent = useAgent(threadId, agentId ?? "");
  const name = agentId ? agent && agentName(agent) : title;
  const machine = useMachineSearch();
  return (
    <Tip label={name ? `Back to ${name}` : "Open parent"}>
      {agentId ? (
        <Link
          to="/t/$threadId/agents/$agentId"
          params={{ threadId, agentId }}
          search={machine}
          aria-label="Open parent"
          className={backClass}
        >
          {icon}
        </Link>
      ) : (
        <Link
          to="/t/$threadId"
          params={{ threadId }}
          search={machine}
          aria-label="Open parent"
          className={backClass}
        >
          {icon}
        </Link>
      )}
    </Tip>
  );
}
