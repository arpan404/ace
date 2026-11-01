import type { LinkedPullRequest, Thread, TurnSummary } from "@ace/protocol";
import {
  forestAsker,
  forestNow,
  nowLine,
  optionEffort,
  providerNames,
  type AgentForestNode,
  type AgentForest,
  type ThreadWork,
} from "@ace/ui-core";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { useNow } from "@/lib/time.ts";
import { agentModelLine } from "../agents/agent-details.ts";
import { useAgentIdentity } from "../agents/agent-identity.ts";

/** The provider, model and effort the thread runs on, quiet in the header row. */
function ModelChip(props: { thread: Pick<Thread, "execution" | "provider" | "acpAgentId"> }) {
  const selection = props.thread.execution;
  const provider = selection?.provider ?? props.thread.provider;
  const model = agentModelLine(selection?.model, optionEffort(selection?.options));
  const runsOn = [providerNames[provider], model].filter(Boolean).join(" · ");
  return (
    <span
      className="flex max-w-[45%] min-w-0 shrink items-center gap-1.5 text-xs text-subtle-foreground"
      title={runsOn}
    >
      <ProviderAccountIcon
        provider={provider}
        acpAgentId={props.thread.acpAgentId}
        instance={selection?.instanceId}
        size={12}
        tooltip={false}
        decorative
      />
      <span className="min-w-0 truncate">{model || providerNames[provider]}</span>
    </span>
  );
}

/** The request the asker waits on: its own, or for a delegate, its thread's main agent's. */
function askOf(asker: AgentForestNode, works: ReadonlyMap<string, ThreadWork>) {
  const own = works.get(asker.threadId)?.interactions.find((i) => i.agentId === asker.agent.id);
  if (own || !asker.childThread) return own;
  return works.get(asker.childThread)?.interactions.find((i) => i.agentId === asker.childRoot?.id);
}

/**
 * Now: one sentence in larger type and one grey line. It names who needs the person and what
 * they ask, with Open to that agent's thread; else how long the thread has worked and what works,
 * or how long it took and what came of it. Failure reads in red, a request in the warning colour,
 * everything else in greys.
 */
export function SummaryNow(props: {
  threadId: string;
  thread: Pick<Thread, "status" | "execution" | "provider" | "acpAgentId">;
  forest: AgentForest;
  works: ReadonlyMap<string, ThreadWork>;
  turn: TurnSummary | undefined;
  prs: readonly LinkedPullRequest[];
  queued: string | undefined;
}) {
  const now = useNow();
  const openSubagent = useOpenSubagent();
  const roots = props.forest.roots;
  const asker = forestAsker(roots);
  const identity = useAgentIdentity(asker?.threadId ?? "", asker?.agent);
  const main = roots[0];
  const rootAgent = main?.kind === "agent" ? main.agent : undefined;
  const isMain = asker?.agent.origin === "root" && asker.threadId === props.threadId;
  const line = nowLine({
    status: props.thread.status,
    // The whole tree, not just the thread's own status: never done while any branch is live.
    ...forestNow(props.forest),
    turn: props.turn && {
      startedAt: props.turn.startedAt,
      endedAt: props.turn.endedAt,
      said: props.turn.latestAgentMessagePreview,
    },
    prs: props.prs,
    now,
    asker: asker && {
      name: identity.name,
      root: isMain,
      request: askOf(asker, props.works)?.request,
    },
    error: rootAgent?.status.state === "failed" ? rootAgent.status.error.message : undefined,
  });
  const tone = line.tone === "plain" ? undefined : line.tone;
  const open =
    asker && !isMain
      ? () =>
          openSubagent({
            threadId: asker.threadId,
            agentId: asker.agent.id,
            childThreadId: asker.agent.machine ? undefined : asker.agent.childThreadId,
          })
      : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2 pt-1">
      <div className="flex min-w-0 items-center gap-2">
        <p
          role="status"
          aria-label={`Thread status: ${line.say}`}
          data-tone={tone}
          className={
            tone
              ? "min-w-0 flex-1 truncate text-lg font-semibold tracking-tight text-(--tone-text)"
              : "min-w-0 flex-1 truncate text-lg font-semibold tracking-tight"
          }
          title={line.say}
        >
          {line.say}
        </p>
        <ModelChip thread={props.thread} />
      </div>
      {(line.sub || open) && (
        <p className="min-w-0 truncate text-xs text-subtle-foreground tabular-nums">
          {line.sub}
          {open && (
            <>
              {line.sub ? " · " : ""}
              <button
                type="button"
                onClick={open}
                aria-label={`Open ${identity.name}`}
                className="focus-ring rounded-xs font-medium text-foreground underline decoration-foreground/30 underline-offset-3 hover:decoration-foreground"
              >
                Open
              </button>
            </>
          )}
        </p>
      )}
      {props.queued && <p className="truncate text-xs text-subtle-foreground">{props.queued}</p>}
    </div>
  );
}
