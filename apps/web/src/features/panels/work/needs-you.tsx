import { useAgent } from "@ace/client-react";
import { formatAgo, type NeedsYouItem } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { rowCard } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useOpenRequest } from "@/lib/request-link.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { useNow } from "@/lib/time.ts";
import { useAgentIdentity } from "../agents/agent-identity.ts";
import { StopAgent } from "../agents/stop-agent.tsx";
import { CapsuleGlyph, CapsuleMeta } from "../agents/task-capsule.tsx";

const requestVerbs: Record<Extract<NeedsYouItem, { kind: "request" }>["request"], string> = {
  approval: "Approve",
  question: "Answer",
  elicitation: "Answer",
  plan_review: "Review",
  browser_help: "Help",
};

/**
 * What waits on the person across the agent tree, each a card with its one action: Show takes a
 * request to its card in the composer's strip (where it is answered), Open goes to an agent
 * that failed or asks from its own thread, Stop ends one that stopped responding. A failure the
 * agent was since resumed past is not here (`needsYou` reads only latest runs).
 */
export function NeedsYouList(props: {
  threadId: string;
  items: readonly NeedsYouItem[];
  subagents: ReadonlyMap<string, number>;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {props.items.map((item) => (
        <NeedsYouRow
          key={item.kind === "request" ? item.id : `${item.kind}:${item.agentId}`}
          threadId={props.threadId}
          item={item}
          subagents={props.subagents.get(item.agentId) ?? 0}
        />
      ))}
    </ul>
  );
}

function NeedsYouRow(props: { threadId: string; item: NeedsYouItem; subagents: number }) {
  const { item } = props;
  const agent = useAgent(props.threadId, item.agentId);
  const { name } = useAgentIdentity(props.threadId, agent);
  const openRequest = useOpenRequest();
  const openSubagent = useOpenSubagent();
  const now = useNow();
  const root = !agent || agent.origin === "root";
  const who = root ? "Main agent" : name;
  const title =
    item.kind === "request"
      ? item.title
      : item.kind === "waiting"
        ? `${who} is waiting on you`
        : item.kind === "failed"
          ? `${who} failed`
          : `${who} stopped responding`;
  const meta =
    item.kind === "request"
      ? `${requestVerbs[item.request]} · ${who}`
      : item.kind === "failed"
        ? item.message
        : item.kind === "stuck"
          ? `Last heard ${formatAgo(item.since, now)}`
          : undefined;
  const open = () =>
    agent &&
    openSubagent({
      threadId: props.threadId,
      agentId: agent.id,
      childThreadId: agent.childThreadId,
    });
  return (
    <li
      aria-label={title}
      className={cn("flex min-h-11 items-center gap-2 py-1.5 pr-1.5 pl-2.5 text-ui", rowCard)}
    >
      <span className="flex h-5 shrink-0 items-center self-start">
        <CapsuleGlyph
          state={item.kind === "request" || item.kind === "waiting" ? "needs-you" : "failed"}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate font-medium" title={title}>
          {title}
        </span>
        {meta && <CapsuleMeta>{meta}</CapsuleMeta>}
      </span>
      {item.kind === "request" ? (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          aria-label={`Show ${title}`}
          onClick={() => openRequest(props.threadId, item.id)}
        >
          Show
        </Button>
      ) : item.kind === "stuck" && agent && !root ? (
        <StopAgent
          threadId={props.threadId}
          agent={agent}
          subagents={props.subagents}
          pending
          className="shrink-0"
        />
      ) : !root ? (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          aria-label={`Open ${who}`}
          onClick={open}
        >
          Open
        </Button>
      ) : null}
    </li>
  );
}
