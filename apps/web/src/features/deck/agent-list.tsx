import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { formatAge, threadStatusLabel, type DeckAgent } from "@ace/ui-core";
import { buttonVariants } from "@/components/ui/button.tsx";
import { ProviderMark } from "@/components/ui/provider-glyph.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";

/**
 * The threads a deck delegated for a card (or for its plan): role, account and live status,
 * each with a way into its thread. A sub-agent sits indented under the lane that started it.
 */
export function AgentList(props: { label: string; agents: readonly DeckAgent[] }) {
  if (!props.agents.length) return null;
  return (
    <ul aria-label={props.label} className="mt-4 flex flex-col">
      {props.agents.map((agent) => (
        <AgentRow key={agent.threadId} agent={agent} />
      ))}
    </ul>
  );
}

function AgentRow(props: { agent: DeckAgent }) {
  const { agent } = props;
  const thread = useSidebarThread(agent.threadId);
  const now = useNow();
  const status = thread ? threadStatusLabel(thread.status) : undefined;
  const updated = agent.updatedAt ?? thread?.updatedAt;
  return (
    <li
      aria-label={`${agent.label}: ${agent.account}`}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t py-2.5 first:border-t-0",
        agent.nested && "pl-5",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-ui">
        {agent.provider && <ProviderMark provider={agent.provider} />}
        <span className="shrink-0 font-medium">{agent.label}</span>
        <span className="min-w-0 truncate text-muted-foreground">{agent.account}</span>
      </span>
      <span className="flex items-center gap-3 text-sm text-muted-foreground">
        {status && (
          <span className="inline-flex items-center gap-1.5">
            {status.tone === "working" && <Spinner />}
            {(status.tone === "needs-you" || status.tone === "failed") && (
              <Dot tone={status.tone} />
            )}
            {status.label}
          </span>
        )}
        {!status && <span>{agent.live ? "Running" : "Finished"}</span>}
        {updated !== undefined && (
          <span className="w-8 text-right text-subtle-foreground tabular-nums">
            {formatAge(updated, now)}
          </span>
        )}
        {thread && (
          <Link
            to="/t/$threadId"
            params={{ threadId: agent.threadId }}
            aria-label={`Open the ${agent.label.toLowerCase()} thread`}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Open thread
          </Link>
        )}
      </span>
    </li>
  );
}
