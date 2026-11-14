import type { LinkedPullRequest, Thread, TurnSummary } from "@ace/protocol";
import {
  forestNow,
  mainAgentError,
  nowLine,
  optionEffort,
  providerNames,
  summaryAsker,
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

/**
 * Now: one short line in text-md 500 and one grey line. It names who needs the person and what
 * they ask, with Open to that agent's thread; else how long the thread has worked and what works,
 * or how long it took and what came of it. The time after the middle dot reads muted. Failure
 * reads in red, a request in the warning colour, everything else in greys.
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
  const asker = summaryAsker(props.threadId, props.forest, props.works);
  const identity = useAgentIdentity(asker?.node.threadId ?? "", asker?.node.agent);
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
    asker: asker && { name: identity.name, root: asker.root, request: asker.request },
    error: mainAgentError(props.forest),
  });
  const tone = line.tone === "plain" ? undefined : line.tone;
  const target = asker?.open;
  const open = target ? () => openSubagent(target) : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-[2px] px-2 pt-1">
      <div className="flex min-w-0 items-center gap-2">
        <p
          role="status"
          aria-label={`Thread status: ${line.speak}`}
          data-tone={tone}
          className={
            tone
              ? "min-w-0 flex-1 truncate text-md font-medium text-(--tone-text) tabular-nums"
              : "min-w-0 flex-1 truncate text-md font-medium tabular-nums"
          }
          title={line.say}
        >
          {line.span ? (
            <>
              {line.lead}
              <span className="font-normal text-muted-foreground"> · {line.span}</span>
            </>
          ) : (
            line.say
          )}
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
